// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js'

type FileInfo = {
  file_id: string
  status: string
  lines?: number
  lines_processed?: number
}

async function fetchFileInfo(apiKey: string, fileId: string): Promise<FileInfo | null> {
  // Ensure fileId is a string and trim it
  const cleanFileId = String(fileId).trim()
  if (!cleanFileId) {
    console.error('fetchFileInfo: empty fileId')
    return null
  }
  
  // Try file_id parameter first (as per documentation)
  let url = `https://bulkapi.millionverifier.com/bulkapi/v2/fileinfo?key=${encodeURIComponent(apiKey)}&file_id=${encodeURIComponent(cleanFileId)}`
  try {
    let res = await fetch(url)
    
    // If 404, try with 'id' parameter instead (some APIs use different param names)
    if (res.status === 404) {
      console.log('fetchFileInfo: 404 with file_id parameter, trying with id parameter', { fileId: cleanFileId })
      url = `https://bulkapi.millionverifier.com/bulkapi/v2/fileinfo?key=${encodeURIComponent(apiKey)}&id=${encodeURIComponent(cleanFileId)}`
      res = await fetch(url)
    }
    
    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      console.error('fetchFileInfo: HTTP error', { 
        fileId: cleanFileId,
        fileIdType: typeof cleanFileId,
        status: res.status, 
        statusText: res.statusText,
        url: url.replace(apiKey, '***'), // Log URL without exposing full key
        response: errorText.substring(0, 200)
      })
      return null
    }
    const json = await res.json().catch(() => null)
    if (!json || typeof json !== 'object') {
      console.error('fetchFileInfo: invalid JSON', { fileId, preview: (await res.text().catch(() => '')).substring(0, 200) })
      return null
    }
    // MillionVerifier returns JSON with status field: in_progress, finished, canceled
    return {
      file_id: fileId,
      status: json.status || '',
      lines: json.lines ? Number(json.lines) : undefined,
      lines_processed: json.lines_processed ? Number(json.lines_processed) : undefined,
    }
  } catch (e) {
    console.error('fetchFileInfo: exception', { fileId, error: (e as any)?.message || String(e) })
    return null
  }
}

async function downloadCsvPairs(apiKey: string, fileId: string, filter: string): Promise<{ result: string; email: string }[]> {
  const url = `https://bulkapi.millionverifier.com/bulkapi/v2/download?key=${encodeURIComponent(apiKey)}&file_id=${encodeURIComponent(fileId)}&filter=${encodeURIComponent(filter)}`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      console.error('downloadCsvPairs: HTTP error', { 
        fileId, 
        filter, 
        status: res.status, 
        statusText: res.statusText,
        response: errorText.substring(0, 200)
      })
      return []
    }
    const text = (await res.text()) || ''
    if (!text.trim()) {
      console.log('downloadCsvPairs: empty response', { fileId, filter })
      return []
    }
    
    const lines = text.split(/\r?\n/)
    const pairs: { result: string; email: string }[] = []
    let headerSkipped = false
    
    for (const line of lines) {
      const l = line.trim()
      if (!l) continue
      
      // Skip header row if present
      if (!headerSkipped && (l.toLowerCase().includes('email') || l.toLowerCase().includes('result'))) {
        headerSkipped = true
        continue
      }
      headerSkipped = true
      
      // MillionVerifier CSV format: typically just email per line when using filters
      // But could also be email,result or result,email
      const parts = l.split(',').map(p => p.trim())
      let email = ''
      let result = filter // Default result is the filter name
      
      if (parts.length === 1) {
        // Just email, no result column
        email = parts[0].toLowerCase()
      } else if (parts.length >= 2) {
        // Try both orders: email,result and result,email
        email = parts[0].toLowerCase()
        result = parts[1].toLowerCase()
        // If first part doesn't look like an email, try reverse
        if (!email.includes('@')) {
          email = parts[1].toLowerCase()
          result = parts[0].toLowerCase()
        }
      }
      
      if (!email.includes('@')) continue
      pairs.push({ result, email })
    }
    
    console.log('downloadCsvPairs: downloaded', { fileId, filter, count: pairs.length, sample: pairs.slice(0, 3) })
    return pairs
  } catch (e) {
    console.error('downloadCsvPairs: exception', { fileId, filter, error: (e as any)?.message || String(e) })
    return []
  }
}

async function processBatch() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SERVICE_ROLE_KEY')!
  const apiKey = Deno.env.get('EMAIL_MILLIONVERIFIER_KEY')
  if (!apiKey) {
    console.error('Missing EMAIL_MILLIONVERIFIER_KEY')
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
  if (files.length === 0) {
    console.log('verification-worker: no files to process')
    return new Response('no files')
  }

  console.log('verification-worker: processing', { fileCount: files.length, fileIds: files.map((f: any) => f.file_id) })

  for (const f of files) {
    try {
      console.log('verification-worker: checking file', { fileId: f.file_id, id: f.id, filename: (f as any).filename })
      const info = await fetchFileInfo(apiKey, f.file_id)
      const nowIso = new Date().toISOString()
      if (!info) {
        console.log('verification-worker: file info null (likely 404 or error)', { 
          fileId: f.file_id,
          fileIdType: typeof f.file_id,
          fileIdLength: String(f.file_id).length
        })
        // Don't mark as checked if it's a 404 - might be a temporary issue or wrong file_id format
        // Only update checked_at if we've tried multiple times
        await supabase
          .from('email_verification_files')
          .update({ checked_at: nowIso })
          .eq('id', f.id)
        continue
      }
      console.log('verification-worker: file info retrieved', { fileId: f.file_id, status: info.status, linesProcessed: info.lines_processed })
      // Update file record with latest info
      await supabase
        .from('email_verification_files')
        .update({
          status: info.status,
          lines_processed: info.lines_processed,
          checked_at: nowIso,
        })
        .eq('id', f.id)

      const statusLower = (info.status || '').toLowerCase()
      // MillionVerifier status: in_progress, finished, canceled
      // Also check if all lines are processed (sometimes status might be different)
      const complete = statusLower === 'finished' || 
                      statusLower === 'completed' || 
                      statusLower === 'done' ||
                      statusLower === 'complete'
      
      // If status doesn't indicate finished, but we have processed all lines, consider it finished
      const allProcessed = info.lines && info.lines_processed && 
                          info.lines > 0 && 
                          info.lines_processed >= info.lines
      
      const isComplete = complete || allProcessed
      
      if (!isComplete) {
        console.log('verification-worker:progress', {
          fileId: f.file_id,
          status: info.status,
          statusLower,
          linesProcessed: info.lines_processed,
          linesTotal: info.lines,
          complete,
          allProcessed,
        })
        continue
      }
      
      console.log('verification-worker: file complete, processing results', {
        fileId: f.file_id,
        status: info.status,
        linesProcessed: info.lines_processed,
        linesTotal: info.lines,
        complete,
        allProcessed,
      })

      // Download results using MillionVerifier filter parameters
      // filter options: ok, ok_and_catch_all, unknown, invalid, all
      console.log('verification-worker: downloading results', { fileId: f.file_id })
      const okPairs = await downloadCsvPairs(apiKey, f.file_id, 'ok')
      const okAndCatchAllPairs = await downloadCsvPairs(apiKey, f.file_id, 'ok_and_catch_all')
      const invalidPairs = await downloadCsvPairs(apiKey, f.file_id, 'invalid')
      const unknownPairs = await downloadCsvPairs(apiKey, f.file_id, 'unknown')
      
      console.log('verification-worker: downloaded counts', {
        fileId: f.file_id,
        ok: okPairs.length,
        okAndCatchAll: okAndCatchAllPairs.length,
        invalid: invalidPairs.length,
        unknown: unknownPairs.length,
        okSample: okPairs.slice(0, 2),
        catchAllSample: okAndCatchAllPairs.slice(0, 2),
      })
      
      // Combine all results
      const allPairs = [...okPairs, ...okAndCatchAllPairs, ...invalidPairs, ...unknownPairs]
      
      // Map MillionVerifier results to our statuses
      // Only ok (not catch_all) -> verified_ok
      // Risky emails (ok_and_catch_all) -> verified_bad (treat as bad)
      const okEmails = Array.from(new Set(okPairs.map(p => p.email)))
      const okEmailsSet = new Set(okEmails) // For fast lookup
      
      // invalid and risky (catch_all) -> verified_bad
      // Exclude emails that are in okEmails (some emails appear in both ok and ok_and_catch_all)
      const badEmails = Array.from(new Set([
        ...invalidPairs.map(p => p.email),
        ...okAndCatchAllPairs
          .map(p => p.email)
          .filter(email => !okEmailsSet.has(email)) // Exclude emails already marked as ok
      ]))
      // unknown -> verified_unknown
      const unknownEmails = Array.from(new Set(unknownPairs.map(p => p.email)))
      
      console.log('verification-worker: mapped emails', {
        fileId: f.file_id,
        okCount: okEmails.length,
        badCount: badEmails.length,
        unknownCount: unknownEmails.length,
        badEmailsSample: Array.from(badEmails).slice(0, 3),
      })

      console.log('verification-worker:complete', {
        fileId: f.file_id,
        status: info.status,
        linesProcessed: info.lines_processed,
        linesTotal: info.lines,
        ok: okEmails.length,
        bad: badEmails.length,
        unknown: unknownEmails.length,
      })

      // Fetch all campaign leads once for case-insensitive email matching
      // Build a map of lowercase email -> lead IDs (one email can map to multiple IDs if duplicates exist)
      const { data: allLeads, error: fetchError } = await supabase
        .from('leads')
        .select('id,email')
        .eq('campaign_id', f.campaign_id)
      
      if (fetchError) {
        console.error('verification-worker:fetch error', fetchError.message)
        throw fetchError
      }

      // Build email -> IDs map (case-insensitive)
      const emailToIds = new Map<string, string[]>()
      for (const lead of (allLeads || [])) {
        if (lead.email) {
          const emailLower = String(lead.email).toLowerCase()
          if (!emailToIds.has(emailLower)) {
            emailToIds.set(emailLower, [])
          }
          emailToIds.get(emailLower)!.push(lead.id)
        }
      }

      // Helper function to update leads by email (case-insensitive)
      async function updateLeadsByEmail(emails: string[], status: 'verified_ok' | 'verified_bad' | 'verified_unknown') {
        const allIds: string[] = []
        for (const email of emails) {
          const emailLower = email.toLowerCase()
          const ids = emailToIds.get(emailLower) || []
          allIds.push(...ids)
        }
        
        if (allIds.length === 0) return

        // Update by ID in chunks to avoid payload limits
        const idChunk = 100
        for (let i = 0; i < allIds.length; i += idChunk) {
          const idSlice = allIds.slice(i, i + idChunk)
          await supabase
            .from('leads')
            .update({ verification_status: status, verification_checked_at: nowIso })
            .in('id', idSlice)
        }
      }

      console.log('verification-worker: updating leads', {
        fileId: f.file_id,
        okCount: okEmails.length,
        badCount: badEmails.length,
        unknownCount: unknownEmails.length,
      })
      
      await updateLeadsByEmail(okEmails, 'verified_ok')
      await updateLeadsByEmail(badEmails, 'verified_bad')
      await updateLeadsByEmail(unknownEmails, 'verified_unknown')
      
      console.log('verification-worker: leads updated', {
        fileId: f.file_id,
        okUpdated: okEmails.length,
        badUpdated: badEmails.length,
        unknownUpdated: unknownEmails.length,
      })

      // Any remaining emails from the upload that are not in ok/bad -> mark as verified_unknown
      try {
        const uploaded: string[] = Array.isArray((f as any).emails) ? ((f as any).emails as any[]).map((e:any)=> String(e).toLowerCase()) : []
        if (uploaded.length) {
          // Consider already known unknowns too
          const known = new Set<string>([...okEmails, ...badEmails, ...unknownEmails].map((e)=> e.toLowerCase()))
          const remainingUnknownEmails = uploaded.filter((e)=> !known.has(e))
          await updateLeadsByEmail(remainingUnknownEmails, 'verified_unknown')
          console.log('verification-worker:unknown_rest', { fileId: f.file_id, unknown: remainingUnknownEmails.length })
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



