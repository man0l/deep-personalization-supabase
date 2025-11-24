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
      url = `https://bulkapi.millionverifier.com/bulkapi/v2/fileinfo?key=${encodeURIComponent(apiKey)}&id=${encodeURIComponent(cleanFileId)}`
      res = await fetch(url)
    }
    
    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      console.error('fetchFileInfo: HTTP error', { 
        fileId: cleanFileId,
        status: res.status, 
        statusText: res.statusText,
      })
      return null
    }
    const json = await res.json().catch(() => null)
    if (!json || typeof json !== 'object') {
      console.error('fetchFileInfo: invalid JSON', { fileId })
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

async function downloadAllResults(apiKey: string, fileId: string): Promise<{ email: string; quality: string; result: string }[]> {
  const url = `https://bulkapi.millionverifier.com/bulkapi/v2/download?key=${encodeURIComponent(apiKey)}&file_id=${encodeURIComponent(fileId)}&filter=all`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      console.error('downloadAllResults: HTTP error', { 
        fileId, 
        status: res.status, 
        statusText: res.statusText,
      })
      return []
    }
    const text = (await res.text()) || ''
    if (!text.trim()) {
      return []
    }
    
    const lines = text.split(/\r?\n/)
    const results: { email: string; quality: string; result: string }[] = []
    let headerSkipped = false
    let emailIdx = -1
    let qualityIdx = -1
    let resultIdx = -1
    
    // Helper function to parse CSV line with quoted fields
    function parseCSVLine(line: string): string[] {
      const fields: string[] = []
      let current = ''
      let inQuotes = false
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            // Escaped quote
            current += '"'
            i++ // Skip next quote
          } else {
            // Toggle quote state
            inQuotes = !inQuotes
          }
        } else if (char === ',' && !inQuotes) {
          // Field separator
          fields.push(current.trim())
          current = ''
        } else {
          current += char
        }
      }
      // Add last field
      fields.push(current.trim())
      
      // Remove quotes from fields
      return fields.map(f => f.replace(/^"|"$/g, ''))
    }
    
    for (const line of lines) {
      const l = line.trim()
      if (!l) continue
      
      // Parse header row
      if (!headerSkipped) {
        const headers = parseCSVLine(l).map(h => h.toLowerCase())
        emailIdx = headers.indexOf('email')
        qualityIdx = headers.indexOf('quality')
        resultIdx = headers.indexOf('result')
        headerSkipped = true
        continue
      }
      
      // Parse data rows
      const parts = parseCSVLine(l)
      if (emailIdx >= 0 && emailIdx < parts.length) {
        const email = parts[emailIdx].toLowerCase().trim()
        const quality = qualityIdx >= 0 && qualityIdx < parts.length ? parts[qualityIdx].toLowerCase().trim() : ''
        const result = resultIdx >= 0 && resultIdx < parts.length ? parts[resultIdx].toLowerCase().trim() : ''
        
        if (email.includes('@')) {
          results.push({ email, quality, result })
        }
      }
    }
    
    return results
  } catch (e) {
    console.error('downloadAllResults: exception', { fileId, error: (e as any)?.message || String(e) })
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
    return new Response('no files')
  }

  for (const f of files) {
    try {
      const info = await fetchFileInfo(apiKey, f.file_id)
      const nowIso = new Date().toISOString()
      if (!info) {
        // Don't mark as checked if it's a 404 - might be a temporary issue or wrong file_id format
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
        continue
      }

      // Download all results from MillionVerifier (using filter=all to get complete CSV with quality/result columns)
      const allResults = await downloadAllResults(apiKey, f.file_id)
      
      // Map MillionVerifier results to our statuses based on quality and result columns
      // quality: "good", "risky", "bad"
      // result: "ok", "catch_all", "invalid", "unknown"
      // Only "good" + "ok" -> verified_ok
      // "risky" + "catch_all" or "bad" + "invalid" -> verified_bad
      // Everything else (including "unknown" result) -> verified_unknown
      const okEmails: string[] = []
      const badEmails: string[] = []
      const unknownEmails: string[] = []
      
      for (const r of allResults) {
        const email = r.email.toLowerCase().trim()
        const quality = r.quality.toLowerCase()
        const result = r.result.toLowerCase()
        
        if (quality === 'good' && result === 'ok') {
          okEmails.push(email)
        } else if ((quality === 'risky' && result === 'catch_all') || (quality === 'bad' && result === 'invalid')) {
          badEmails.push(email)
        } else {
          // Everything else (unknown result, or any other combination)
          unknownEmails.push(email)
        }
      }
      
      // Remove duplicates
      const okEmailsSet = new Set(okEmails)
      const badEmailsSet = new Set(badEmails)
      const unknownEmailsSet = new Set(unknownEmails)

      // Fetch ALL campaign leads for case-insensitive email matching
      // We use all leads (not filtered by file.emails) to ensure we can match
      // any email returned by MillionVerifier, even if there are formatting differences
      const { data: allLeads, error: fetchError } = await supabase
        .from('leads')
        .select('id,email')
        .eq('campaign_id', f.campaign_id)
      
      if (fetchError) {
        console.error('verification-worker:fetch error', fetchError.message)
        throw fetchError
      }
      
      // Build email -> IDs map (case-insensitive) from ALL campaign leads
      const emailToIds = new Map<string, string[]>()
      for (const lead of (allLeads || [])) {
        if (lead.email) {
          const emailLower = String(lead.email).toLowerCase().trim()
          if (!emailToIds.has(emailLower)) {
            emailToIds.set(emailLower, [])
          }
          emailToIds.get(emailLower)!.push(lead.id)
        }
      }
      
      // Helper function to update leads by email (case-insensitive)
      async function updateLeadsByEmail(emails: string[], status: 'verified_ok' | 'verified_bad' | 'verified_unknown') {
        const allIds: string[] = []
        const notFound: string[] = []
        for (const email of emails) {
          const emailLower = email.toLowerCase().trim()
          const ids = emailToIds.get(emailLower) || []
          if (ids.length === 0) {
            notFound.push(emailLower)
          } else {
            allIds.push(...ids)
          }
        }
        
        if (allIds.length === 0) {
          return
        }

        // Update by ID in chunks to avoid payload limits
        const idChunk = 100
        let updatedCount = 0
        for (let i = 0; i < allIds.length; i += idChunk) {
          const idSlice = allIds.slice(i, i + idChunk)
          const { error: updateError } = await supabase
            .from('leads')
            .update({ verification_status: status, verification_checked_at: nowIso })
            .in('id', idSlice)
          
          if (updateError) {
            console.error('verification-worker: update error', {
              fileId: f.file_id,
              status,
              error: updateError.message,
              chunkIndex: i,
            })
          } else {
            updatedCount += idSlice.length
          }
        }
      }

      await updateLeadsByEmail(Array.from(okEmailsSet), 'verified_ok')
      await updateLeadsByEmail(Array.from(badEmailsSet), 'verified_bad')
      await updateLeadsByEmail(Array.from(unknownEmailsSet), 'verified_unknown')

      // Any remaining emails from the upload that are not in any result -> mark as verified_unknown
      try {
        const uploaded: string[] = Array.isArray((f as any).emails) ? ((f as any).emails as any[]).map((e:any)=> String(e).toLowerCase().trim()) : []
        if (uploaded.length) {
          // Consider all known results
          const known = new Set<string>([...okEmailsSet, ...badEmailsSet, ...unknownEmailsSet])
          const remainingUnknownEmails = uploaded.filter((e)=> !known.has(e))
          if (remainingUnknownEmails.length > 0) {
            await updateLeadsByEmail(remainingUnknownEmails, 'verified_unknown')
          }
        }
      } catch (e) {
        console.error('verification-worker:unknown error', (e as any)?.message || String(e))
      }

      // Log successful processing
      console.log('verification-worker: processed', {
        fileId: f.file_id,
        ok: okEmailsSet.size,
        bad: badEmailsSet.size,
        unknown: unknownEmailsSet.size,
      })

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



