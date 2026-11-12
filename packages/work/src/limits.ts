/**
 * The reasons that mean an Account is out of quota or credits (sc-14): the one list. An attempt that
 * failed with such a reason is recorded as `limited`, not failed; the step is routed again.
 */
export const QUOTA_LIMITED = /rate.?limit|too many requests|\b429\b|usage limit|out of credits|quota exceeded/i

export const isQuotaLimited = (reason?: string): boolean => QUOTA_LIMITED.test(reason ?? '')
