// @ts-nocheck
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js'
import { LeadEnricher } from './types.ts'

type Ctx = { supabase: SupabaseClient, openaiKey: string }

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

function errToString(err: any): string {
  try {
    if (!err) return 'unknown error'
    if (typeof err === 'string') return err
    if (typeof err.toString === 'function') return err.toString()
    return JSON.stringify(err)
  } catch {
    try { return String(err) } catch { return 'error' }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 12000
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(id)
  }
}

async function fetchHtml(url: string): Promise<string> {
  const headers = {
    'user-agent': 'Mozilla/5.0 (compatible; LeadEnricher/1.0; +https://example.com)'
  }
  let lastErr: any
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers, timeoutMs: 12000 })
      if (!res.ok) throw new Error(`fetch ${url} ${res.status}`)
      // Stream and cap at ~300KB
      const reader = res.body?.getReader()
      if (!reader) return await res.text()
      const chunks: Uint8Array[] = []
      let received = 0
      const CAP = 300 * 1024
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value?.length || 0
        chunks.push(value)
        if (received >= CAP) break
      }
      const combined = new Uint8Array(chunks.reduce((acc, cur) => acc + cur.length, 0))
      let offset = 0
      for (const c of chunks) { combined.set(c, offset); offset += c.length }
      return new TextDecoder('utf-8').decode(combined)
    } catch (e) {
      lastErr = e
      if (attempt === 0) await sleep(300)
    }
  }
  throw lastErr || new Error(`fetch ${url} failed`)
}

function htmlToPlainText(html: string): string {
  try {
    if (!html) return ''
    let out = html
    // Strip head/noscript/script/style blocks entirely
    out = out.replace(/<head[\s\S]*?<\/head>/gi, '')
    out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    out = out.replace(/<script[\s\S]*?<\/script>/gi, '')
    out = out.replace(/<style[\s\S]*?<\/style>/gi, '')
    // Insert newlines around common block elements to preserve structure
    const blockTags = ['p','div','section','article','header','footer','main','aside','ul','ol','li','table','thead','tbody','tr','td','th','pre','code','blockquote','h1','h2','h3','h4','h5','h6','br']
    for (const t of blockTags) {
      const reOpen = new RegExp(`<${t}[^>]*>`, 'gi')
      const reClose = new RegExp(`</${t}>`, 'gi')
      out = out.replace(reOpen, '\n')
      out = out.replace(reClose, '\n')
    }
    // Remove remaining tags
    out = out.replace(/<[^>]+>/g, '')
    // Decode a few common entities
    out = out
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    // Collapse whitespace and limit blank lines
    out = out.replace(/[\t\f\r ]+/g, ' ')
    out = out.replace(/\n{3,}/g, '\n\n')
    return out.trim()
  } catch {
    return html
  }
}

// Use plain-text cleaning (no Turndown, no fallbacks)
function htmlToMarkdown(html: string): string {
  if (!html) throw new Error('empty html')
  return htmlToPlainText(html)
}

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u)
    url.hash = ''
    return url.href
  } catch { return u }
}

function extractInternalLinks(html: string, homeUrl: string): string[] {
  const results: string[] = []
  const home = new URL(homeUrl)
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = (m[1] || '').trim()
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue
    try {
      const abs = new URL(href, home).href
      const absUrl = new URL(abs)
      if (absUrl.hostname === home.hostname) {
        results.push(normalizeUrl(abs))
      }
    } catch {}
  }
  // de-duplicate preserving order
  const seen = new Set<string>()
  return results.filter(u => (seen.has(u) ? false : (seen.add(u), true)))
}

async function openAiChat(key: string, messages: any[]) {
  console.log('openAiChat:call', { messagesCount: messages?.length ?? 0, hasKey: Boolean(key) })
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-5-nano', messages })
    })
    if (!res.ok) {
      const body = await res.text().catch(()=> '')
      throw new Error(`openai ${res.status}: ${body.slice(0, 200)}`)
    }
    const json = await res.json()
    console.log('openAiChat:response', { hasChoices: Boolean(json?.choices?.length), model: json?.model })
    return json.choices?.[0]?.message?.content as string
  } catch (e) {
    const msg = errToString(e)
    console.error('openAiChat:error', msg)
    throw new Error(msg)
  }
}

function extractAbstract(content: string): string {
  if (!content) return ''
  const trimmed = content.trim()
  // Try raw JSON first
  try {
    const obj = JSON.parse(trimmed)
    if (obj && typeof obj === 'object' && typeof obj.abstract === 'string') return obj.abstract
  } catch {}
  // Try to find a JSON block inside code fences or text
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const obj = JSON.parse(match[0])
      if (obj && typeof obj === 'object' && typeof obj.abstract === 'string') return obj.abstract
    } catch {}
  }
  // If we didn't find valid JSON with an abstract, treat as no result
  return ''
}

function extractHeadlineFromRaw(raw: any): string | null {
  try {
    if (!raw) return null
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    const cand = obj?.Headline ?? obj?.headline ?? obj?.profile?.Headline ?? obj?.profile?.headline ?? obj?.linkedin?.headline
    if (typeof cand === 'string' && cand.trim()) return cand.trim()
    return null
  } catch {
    return null
  }
}

export class WebsiteScrapeEnricher implements LeadEnricher {
  private supabase: SupabaseClient
  private openaiKey: string
  constructor(ctx: Ctx) {
    this.supabase = ctx.supabase
    this.openaiKey = ctx.openaiKey
    console.log('WebsiteScrapeEnricher:init', { hasOpenAIKey: Boolean(this.openaiKey) })
  }

  async enrich({ leadId }: { leadId: string }): Promise<{ iceBreaker: string }> {
    const t0 = Date.now()
    console.log('WebsiteScrapeEnricher:enrich:start', { leadId })
    const { lead, campaign } = await this.loadLeadAndCampaign(leadId)
    const { base, homepage } = this.computeBaseAndHomepage(lead)
    const urls = await this.discoverUrls(homepage)
    const pageSummaries = await this.summarizeTopPages(urls, campaign, lead, base, 3)
    if (pageSummaries.length === 0) throw new Error('no page summaries from website')
    const iceBreaker = await this.generateIcebreaker(campaign, lead, pageSummaries)
    console.log('WebsiteScrapeEnricher:enrich:done', { leadId, tookMs: Date.now() - t0, chars: (iceBreaker || '').length })
    return { iceBreaker }
  }

  private async loadLeadAndCampaign(leadId: string): Promise<{ lead: any, campaign: any }> {
    const { data: lead } = await this.supabase.from('leads').select('*').eq('id', leadId).single()
    if (!lead) throw new Error('lead not found')
    const { data: campaign } = await this.supabase.from('campaigns').select('*').eq('id', lead.campaign_id).single()
    if (!campaign) throw new Error('campaign not found')
    return { lead, campaign }
  }

  private computeBaseAndHomepage(lead: any): { base: string, homepage: string } {
    const base = (lead.company_website || '').replace(/^(https?:\/\/)?/,'')
    const homepage = `https://${base}`
    return { base, homepage }
  }

  private async discoverUrls(homepage: string): Promise<string[]> {
    let discovered: string[] = []
    try {
      const htmlHome = await fetchHtml(homepage)
      discovered = extractInternalLinks(htmlHome, homepage)
    } catch {}
    // Shuffle helper
    const shuffle = <T>(arr: T[]): T[] => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
      return arr
    }
    const getExt = (u: string): string | null => {
      try {
        const path = new URL(u).pathname
        const last = path.split('/').filter(Boolean).pop() || ''
        const dotIdx = last.lastIndexOf('.')
        if (dotIdx <= 0) return null
        return last.slice(dotIdx + 1).toLowerCase()
      } catch { return null }
    }
    const badExt = new Set(['mp4','mov','avi','mkv','webm','mp3','wav','flac','pdf','png','jpg','jpeg','gif','svg','ico','webp','css','js','json','xml','zip','rar','7z','gz','tar'])
    const docExt = new Set(['html','htm','php','asp','aspx','md','txt'])

    const pool = discovered.filter(Boolean)
    shuffle(pool)
    const selected: string[] = []
    let preferExt: string | null = null
    for (const url of pool) {
      if (selected.length >= 3) break
      const ext = getExt(url)
      if (preferExt) {
        if (ext === preferExt) selected.push(url)
        continue
      }
      if (!ext) { // no extension → good candidate
        selected.push(url)
        continue
      }
      if (badExt.has(ext)) { // skip media/static
        continue
      }
      if (docExt.has(ext)) {
        selected.push(url)
        preferExt = ext // if we picked an extension, prefer same ext next
      }
    }
    const homeNormalized = normalizeUrl(homepage)
    const normalizedSelected = selected.map((u) => normalizeUrl(u)).filter(Boolean) as string[]
    const urls = Array.from(new Set([homeNormalized, ...normalizedSelected]))
    return urls
  }

  private async summarizeTopPages(urls: string[], campaign: any, lead: any, base: string, limit: number): Promise<string[]> {
    const pageSummaries: string[] = []
    const errors: string[] = []
    for (const url of urls) {
      if (pageSummaries.length >= limit) break
      const res = await this.summarizeSingleUrl(url, campaign, lead, base)
      if (res.abstract) pageSummaries.push(`URL: ${url}\n${res.abstract}`)
      if (res.error) errors.push(res.error)
    }
    // Keep summaries we have; if none succeeded, throw the last error to surface a reason
    if (pageSummaries.length === 0 && errors.length > 0) {
      throw new Error(errors[errors.length - 1])
    }
    return pageSummaries
  }

  private async summarizeSingleUrl(url: string, campaign: any, lead: any, base: string): Promise<{ abstract?: string, error?: string }> {
    try {
      const html = await fetchHtml(url)
      const md = htmlToMarkdown(html)
      const template = (campaign.summarize_prompt || '').trim()
      const contentSnippet = md.slice(0, 6000)
      const prompt = template.includes('{markdown}')
        ? template.replace('{url}', url).replace('{markdown}', contentSnippet)
        : `Summarize the following webpage content from ${lead.company_name || 'the company'} (${base}). Return JSON exactly {"abstract":"..."}. If the content isn't clearly about this company/site, return {"abstract":"no content"}.\n\nURL: ${url}\n\nCONTENT START\n${contentSnippet}\nCONTENT END`
      const sys = `You are summarizing a company's OWN webpage for LLM enrichment.\n\nRules:\n- Company: ${lead.company_name || ''}\n- Primary domain (must match): ${base}\n- URL being summarized: ${url}\n- Summarize ONLY if the content clearly pertains to THIS business (its offering/services, about, work/portfolio).\n- If the content is generic, news-like, scraped wrong, or not obviously about this company/site, output exactly: {"abstract":"no content"}.\n- Respond ONLY in JSON exactly like {"abstract":"..."}. No commentary before or after the JSON.`
      const summary = await openAiChat(this.openaiKey, [
        { role: 'system', content: sys },
        { role: 'user', content: prompt }
      ])
      const abstract = extractAbstract(summary)
      if (!abstract) {
        return { error: 'openai: invalid or non-JSON summary' }
      }
      return { abstract: abstract || 'no content' }
    } catch (err) {
      const msg = errToString(err)
      console.error('WebsiteScrapeEnricher:summarize:error', { url, err: msg })
      const category = /openai/i.test(msg) ? 'openai' : 'scrape'
      return { error: `${category}: ${msg}` }
    }
  }

  private async generateIcebreaker(campaign: any, lead: any, pageSummaries: string[]): Promise<string> {
    const icePrompt = campaign.icebreaker_prompt
      .replace('{serviceLine}', campaign.service_line)
    const profile = {
      full_name: lead.full_name || [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() || null,
      title: lead.title || null,
      headline: extractHeadlineFromRaw(lead.raw) || null,
      industry: lead.industry || null,
      city: lead.city || null,
      state: lead.state || lead.region || null,
      country: lead.country || null,
    }
    let iceBreaker: string
    try {
      iceBreaker = await openAiChat(this.openaiKey, [
        { role: 'system', content: "You're a helpful, intelligent sales assistant." },
        { role: 'assistant', content: "Hey Aina,\n\nLove what you're doing at Maki. Also doing some outsourcing right now, wanted to run something by you.\n\nSo I hope you'll forgive me, but I creeped you/Maki quite a bit. I know that discretion is important to you guys (or at least I'm assuming this given the part on your website about white-labelling your services) and I put something together a few months ago that I think could help. To make a long story short, it's an outreach system that uses AI to find people hiring website devs. Then pitches them with templates (actually makes them a white-labelled demo website). Costs just a few cents to run, very high converting, and I think it's in line with Maki's emphasis on scalability." },
        { role: 'user', content: icePrompt },
        { role: 'user', content: "Profile: " + JSON.stringify(profile) + "\n\nWebsite summaries: " + pageSummaries.join('\n\n')}
      ])
    } catch (e) {
      const msg = errToString(e)
      console.error('WebsiteScrapeEnricher:ice:error', { err: msg })
      throw new Error(msg)
    }
    return iceBreaker
  }
}


