// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js'
import { WebsiteScrapeEnricher } from './_shared/enrichment/WebsiteScrapeEnricher.ts'

type Job = { leadId: string }

function extractIcebreakerText(content: string): string {
  if (!content) return ''
  const trimmed = content.trim()
  // Try raw JSON first
  try {
    const obj = JSON.parse(trimmed)
    if (obj && typeof obj === 'object' && typeof obj.icebreaker === 'string') {
      return obj.icebreaker.trim()
    }
  } catch {}
  // Try to find a JSON block inside the text (e.g., code fences)
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const obj = JSON.parse(match[0])
      if (obj && typeof obj === 'object' && typeof obj.icebreaker === 'string') {
        return obj.icebreaker.trim()
      }
    } catch {}
  }
  return trimmed
}

async function runJob(job: Job) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SERVICE_ROLE_KEY')!
  const openaiKey = Deno.env.get('OPENAI_API_KEY')!
  const supabase = createClient(supabaseUrl, serviceKey)

  const startAt = Date.now()
  console.log('runJob:start', { leadId: job.leadId, hasOpenAIKey: Boolean(openaiKey) })

  const { data: lead, error: leadErr } = await supabase.from('leads').select('id,ice_status,campaign_id').eq('id', job.leadId).single()
  if (leadErr) {
    console.error('load lead error', leadErr.message, job.leadId)
    return
  }
  if (!lead || lead.ice_status === 'done') return
  await supabase.from('leads').update({ ice_status: 'processing' }).eq('id', job.leadId)
  console.log('runJob:status->processing', { leadId: job.leadId })

  const enricher = new WebsiteScrapeEnricher({ supabase, openaiKey })
  try {
    const { iceBreaker } = await enricher.enrich({ leadId: job.leadId })
    const iceBreakerText = extractIcebreakerText(iceBreaker)
    await supabase.from('leads').update({ ice_breaker: iceBreakerText, ice_status: 'done', enriched_at: new Date().toISOString() }).eq('id', job.leadId)
    console.log('runJob:done', { leadId: job.leadId, iceBreakerChars: (iceBreakerText || '').length, durationMs: Date.now() - startAt })
  } catch (e) {
    const errStr = (e && (e as any).toString) ? (e as any).toString() : ((e && (e as any).message) || String(e))
    console.error('enrich error', job.leadId, errStr)
    await supabase.from('enrichment_jobs').upsert({ lead_id: job.leadId, campaign_id: lead?.campaign_id, status: 'error', error: errStr, updated_at: new Date().toISOString() }, { onConflict: 'lead_id' })
    await supabase.from('leads').update({ ice_status: 'error' }).eq('id', job.leadId)
  }
}

// Process a single batch from the queue; invoke via cron to control invocations
async function processBatch() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceKey)
  const concurrency = Number(Deno.env.get('QUEUE_CONCURRENCY') || '10')
  const vtSeconds = Number(Deno.env.get('QUEUE_VT_SECONDS') || '120')

  const internalParallel = Number(Deno.env.get('INTERNAL_PARALLEL') || '1')
  const claimCount = Math.max(1, Math.min(concurrency, internalParallel || 1))
  const { data, error } = await supabase.rpc('dequeue_and_claim_lead_enrichment', { cnt: claimCount, vt_seconds: vtSeconds })
  if (error) {
    console.error('queue error', error.message)
    return new Response('queue error', { status: 500 })
  }
  const jobs = (data || []) as { msg_id: number, lead_id: string }[]
  console.log('processBatch:dequeued', { count: jobs.length, claimCount, internalParallel, concurrency, vtSeconds })
  if (internalParallel && internalParallel > 1) {
    for (let i = 0; i < jobs.length; i += internalParallel) {
      const group = jobs.slice(i, i + internalParallel)
      await Promise.allSettled(group.map(async (j) => {
        try {
          await runJob({ leadId: j.lead_id })
        } finally {
          try {
            await supabase.rpc('ack_lead_enrichment', { mid: j.msg_id })
            console.log('processBatch:acked', { msgId: j.msg_id, leadId: j.lead_id })
          } catch (ackErr) {
            console.error('processBatch:ack error', { msgId: j.msg_id, err: (ackErr as any)?.message || String(ackErr) })
          }
        }
      }))
    }
  } else {
    for (const j of jobs) {
      try {
        await runJob({ leadId: j.lead_id })
      } finally {
        try {
          await supabase.rpc('ack_lead_enrichment', { mid: j.msg_id })
          console.log('processBatch:acked', { msgId: j.msg_id, leadId: j.lead_id })
        } catch (ackErr) {
          console.error('processBatch:ack error', { msgId: j.msg_id, err: (ackErr as any)?.message || String(ackErr) })
        }
      }
    }
  }
  return new Response(`processed ${jobs.length}`)
}

Deno.serve((_req) => {
  return processBatch()
})


