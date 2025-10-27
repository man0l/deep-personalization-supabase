export interface LeadEnricher {
  enrich(input: { leadId: string }): Promise<{ iceBreaker: string }>
}

export type SummarizePromptInput = {
  url: string
  markdown: string
}

export type IceBreakerPromptInput = {
  firstName?: string | null
  lastName?: string | null
  fullName?: string | null
  title?: string | null
  companyName?: string | null
  companyWebsite?: string | null
  industry?: string | null
  serviceLine: string
  pageSummaries: string
}


