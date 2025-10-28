// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js'

type FileInfo = {
  file_id: string
  filename: string
  unique: number
  lines: number
  lines_processed: number
  status: string
  timestamp: string
  link1?: string
  link2?: string
}

async function fetchFileInfo(apiKey: string, fileId: string): Promise<FileInfo | null> {
  const url = `https://apps.emaillistverify.com/api/getApiFileInfo?secret=${encodeURIComponent(apiKey)}&id=${encodeURIComponent(fileId)}`
  const res = await fetch(url)
  if (!res.ok) return null
  const text = (await res.text()).trim()
  // Expected pipe-separated values
  const parts = text.split('|')
  if (parts.length < 7) return null
  const [fId, filename, unique, lines, linesProcessed, status, ts, link1, link2] = parts
  return {
    file_id: fId,
    filename,
    unique: Number(unique || '0'),
    lines: Number(lines || '0'),
    lines_processed: Number(linesProcessed || '0'),
    status: status || '',
    timestamp: ts || '',
    link1,
    link2,
  }
}

async function downloadCsvPairs(url?: string): Promise<{ result: string; email: string }[]> {
  if (!url) return []
  const res = await fetch(url)
  if (!res.ok) return []
  const text = (await res.text()) || ''
  const lines = text.split(/\r?\n/)
  const pairs: { result: string; email: string }[] = []
  for (const line of lines) {
    const l = line.trim()
    if (!l) continue
    if (l.toLowerCase().startsWith('elv result')) continue
    const idx = l.indexOf(',')
    if (idx === -1) continue
    const result = l.slice(0, idx).trim().toLowerCase()
    const email = l.slice(idx + 1).trim().toLowerCase()
    if (!email.includes('@')) continue
    pairs.push({ result, email })
  }
  return pairs
}

async function processBatch() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SERVICE_ROLE_KEY')!
  const apiKey = Deno.env.get('EMAIL_LIST_VERIFY_KEY') || Deno.env.get('ELV_API_KEY')
  if (!apiKey) {
    console.error('Missing EMAIL_LIST_VERIFY_KEY')
    return new Response('missing key', { status: 500 })
  }
  const supabase = createClient(supabaseUrl, serviceKey)

  // Pull a small batch of unprocessed records
  const { data: rows, error } = await supabase
    .from('email_verification_files')
    .select('id,campaign_id,file_id,lines,processed,emails')
    .eq('processed', false)
    .order('created_at', { ascending: true })
    .limit(20)

  if (error) {
    console.error('load files error', error.message)
    return new Response('error', { status: 500 })
  }
  const files = rows || []
  if (files.length === 0) return new Response('no files')

  for (const f of files) {
    try {
      const info = await fetchFileInfo(apiKey, f.file_id)
      const nowIso = new Date().toISOString()
      if (!info) {
        await supabase
          .from('email_verification_files')
          .update({ checked_at: nowIso })
          .eq('id', f.id)
        continue
      }
      // Update file record with latest info
      await supabase
        .from('email_verification_files')
        .update({
          status: info.status,
          lines_processed: info.lines_processed,
          link1: info.link1 || null,
          link2: info.link2 || null,
          checked_at: nowIso,
        })
        .eq('id', f.id)

      const statusLower = (info.status || '').toLowerCase()
      const complete = statusLower.includes('complete') || statusLower.includes('finish') || statusLower.includes('ready')
      if (!complete) {
        console.log('verification-worker:progress', {
          fileId: f.file_id,
          status: info.status,
          linesProcessed: info.lines_processed,
          linesTotal: info.lines,
        })
        continue
      }

      // Use provider links directly; parse CSV pairs (result,email)
      const okPairs = await downloadCsvPairs(info.link1)
      const allPairs = await downloadCsvPairs(info.link2)
      const okEmails = Array.from(new Set(okPairs.filter(p=> p.result==='ok').map(p=> p.email)))
      const badSet = new Set(['invalid_syntax','invalid_mx','email_disabled','dead_server','disposable','spamtrap'])
      const unkSet = new Set(['unknown','ok_for_all','antispam_system','smtp_protocol'])
      const badEmails = Array.from(new Set(allPairs.filter(p=> badSet.has(p.result)).map(p=> p.email)))
      const unknownEmails = Array.from(new Set(allPairs.filter(p=> unkSet.has(p.result)).map(p=> p.email)))

      console.log('verification-worker:complete', {
        fileId: f.file_id,
        status: info.status,
        linesProcessed: info.lines_processed,
        linesTotal: info.lines,
        ok: okEmails.length,
        bad: badEmails.length,
        unknown: unknownEmails.length,
      })

      // Batch updates by email within campaign
      const chunk = 500
      for (let i = 0; i < okEmails.length; i += chunk) {
        const slice = okEmails.slice(i, i + chunk)
        if (slice.length) {
          await supabase
            .from('leads')
            .update({ verification_status: 'verified_ok', verification_checked_at: nowIso })
            .eq('campaign_id', f.campaign_id)
            .in('email', slice)
        }
      }
      for (let i = 0; i < badEmails.length; i += chunk) {
        const slice = badEmails.slice(i, i + chunk)
        if (slice.length) {
          await supabase
            .from('leads')
            .update({ verification_status: 'verified_bad', verification_checked_at: nowIso })
            .eq('campaign_id', f.campaign_id)
            .in('email', slice)
        }
      }

      // Mark unknown category explicitly
      for (let i = 0; i < unknownEmails.length; i += chunk) {
        const slice = unknownEmails.slice(i, i + chunk)
        if (slice.length) {
          await supabase
            .from('leads')
            .update({ verification_status: 'verified_unknown', verification_checked_at: nowIso })
            .eq('campaign_id', f.campaign_id)
            .in('email', slice)
        }
      }

      // Any remaining emails from the upload that are not in ok/bad -> mark as verified_unknown
      try {
        const uploaded: string[] = Array.isArray((f as any).emails) ? ((f as any).emails as any[]).map((e:any)=> String(e).toLowerCase()) : []
        if (uploaded.length) {
          // Consider already known unknowns too
          const known = new Set<string>([...okEmails, ...badEmails, ...unknownEmails].map((e)=> e.toLowerCase()))
          const unknownEmails = uploaded.filter((e)=> !known.has(e))
          for (let i = 0; i < unknownEmails.length; i += chunk) {
            const slice = unknownEmails.slice(i, i + chunk)
            if (slice.length) {
              await supabase
                .from('leads')
                .update({ verification_status: 'verified_unknown', verification_checked_at: nowIso })
                .eq('campaign_id', f.campaign_id)
                .in('email', slice)
            }
          }
          console.log('verification-worker:unknown_rest', { fileId: f.file_id, unknown: unknownEmails.length })
        }
      } catch (e) {
        console.error('verification-worker:unknown error', (e as any)?.message || String(e))
      }

      // Mark file as processed
      await supabase
        .from('email_verification_files')
        .update({ processed: true })
        .eq('id', f.id)
    } catch (e) {
      console.error('verification-worker error', f.file_id, (e as any)?.message || String(e))
    }
  }

  return new Response(`checked ${files.length}`)
}

Deno.serve((_req) => processBatch())


