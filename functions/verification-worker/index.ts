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
        response: errorText.substring(0, 200)
      })
      return []
    }
    const text = (await res.text()) || ''
    if (!text.trim()) {
      console.log('downloadAllResults: empty response', { fileId })
      return []
    }
    
    const lines = text.split(/\r?\n/)
    const results: { email: string; quality: string; result: string }[] = []
    let headerSkipped = false
    let emailIdx = -1
    let qualityIdx = -1
    let resultIdx = -1
    
    for (const line of lines) {
      const l = line.trim()
      if (!l) continue
      
      // Parse header row
      if (!headerSkipped) {
        const headers = l.split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''))
        emailIdx = headers.indexOf('email')
        qualityIdx = headers.indexOf('quality')
        resultIdx = headers.indexOf('result')
        headerSkipped = true
        continue
      }
      
      // Parse data rows
      const parts = l.split(',').map(p => p.trim().replace(/"/g, ''))
      if (emailIdx >= 0 && emailIdx < parts.length) {
        const email = parts[emailIdx].toLowerCase()
        const quality = qualityIdx >= 0 && qualityIdx < parts.length ? parts[qualityIdx].toLowerCase() : ''
        const result = resultIdx >= 0 && resultIdx < parts.length ? parts[resultIdx].toLowerCase() : ''
        
        if (email.includes('@')) {
          results.push({ email, quality, result })
        }
      }
    }
    
    console.log('downloadAllResults: downloaded', { fileId, count: results.length, sample: results.slice(0, 3) })
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

      // Download all results from MillionVerifier (using filter=all to get complete CSV with quality/result columns)
      console.log('verification-worker: downloading all results', { fileId: f.file_id })
      const allResults = await downloadAllResults(apiKey, f.file_id)
      
      console.log('verification-worker: downloaded counts', {
        fileId: f.file_id,
        total: allResults.length,
        sample: allResults.slice(0, 3),
      })
      
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
      
      console.log('verification-worker: mapped emails', {
        fileId: f.file_id,
        okCount: okEmailsSet.size,
        badCount: badEmailsSet.size,
        unknownCount: unknownEmailsSet.size,
        okEmailsSample: Array.from(okEmailsSet).slice(0, 5),
        badEmailsSample: Array.from(badEmailsSet).slice(0, 5),
        unknownEmailsSample: Array.from(unknownEmailsSet).slice(0, 5),
      })

      console.log('verification-worker:complete', {
        fileId: f.file_id,
        status: info.status,
        linesProcessed: info.lines_processed,
        linesTotal: info.lines,
        ok: okEmailsSet.size,
        bad: badEmailsSet.size,
        unknown: unknownEmailsSet.size,
      })

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
      
      console.log('verification-worker: emailToIds map built', {
        fileId: f.file_id,
        mapSize: emailToIds.size,
        sampleKeys: Array.from(emailToIds.keys()).slice(0, 5),
      })
      
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
        
        if (notFound.length > 0) {
          console.log('verification-worker: emails not found in map', {
            fileId: f.file_id,
            status,
            notFoundCount: notFound.length,
            notFoundSample: notFound.slice(0, 5),
            totalEmails: emails.length,
            foundIds: allIds.length,
          })
        }
        
        if (allIds.length === 0) {
          console.log('verification-worker: no IDs to update', {
            fileId: f.file_id,
            status,
            emailCount: emails.length,
            emailToIdsSize: emailToIds.size,
          })
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
        
        console.log('verification-worker: updateLeadsByEmail result', {
          fileId: f.file_id,
          status,
          emailCount: emails.length,
          idCount: allIds.length,
          updatedCount,
        })
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
        
        if (notFound.length > 0) {
          console.log('verification-worker: emails not found in map', {
            fileId: f.file_id,
            status,
            notFoundCount: notFound.length,
            notFoundSample: notFound.slice(0, 5),
            totalEmails: emails.length,
            foundIds: allIds.length,
          })
        }
        
        if (allIds.length === 0) {
          console.log('verification-worker: no IDs to update', {
            fileId: f.file_id,
            status,
            emailCount: emails.length,
            emailToIdsSize: emailToIds.size,
          })
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
        
        console.log('verification-worker: updateLeadsByEmail result', {
          fileId: f.file_id,
          status,
          emailCount: emails.length,
          idCount: allIds.length,
          updatedCount,
        })
      }

      console.log('verification-worker: updating leads', {
        fileId: f.file_id,
        okCount: okEmailsSet.size,
        badCount: badEmailsSet.size,
        unknownCount: unknownEmailsSet.size,
      })
      
      await updateLeadsByEmail(Array.from(okEmailsSet), 'verified_ok')
      await updateLeadsByEmail(Array.from(badEmailsSet), 'verified_bad')
      await updateLeadsByEmail(Array.from(unknownEmailsSet), 'verified_unknown')
      
      console.log('verification-worker: leads updated', {
        fileId: f.file_id,
        okUpdated: okEmailsSet.size,
        badUpdated: badEmailsSet.size,
        unknownUpdated: unknownEmailsSet.size,
      })

      // Any remaining emails from the upload that are not in any result -> mark as verified_unknown
      try {
        const uploaded: string[] = Array.isArray((f as any).emails) ? ((f as any).emails as any[]).map((e:any)=> String(e).toLowerCase().trim()) : []
        if (uploaded.length) {
          // Consider all known results
          const known = new Set<string>([...okEmailsSet, ...badEmailsSet, ...unknownEmailsSet])
          const remainingUnknownEmails = uploaded.filter((e)=> !known.has(e))
          if (remainingUnknownEmails.length > 0) {
            await updateLeadsByEmail(remainingUnknownEmails, 'verified_unknown')
            console.log('verification-worker:unknown_rest', { fileId: f.file_id, unknown: remainingUnknownEmails.length, sample: remainingUnknownEmails.slice(0, 3) })
          }
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



