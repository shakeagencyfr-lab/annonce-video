/**
 * Why a listing could not be read, as logged in read_failures with the platform
 * (CLAUDE.md, "Stratégie de lecture"). The message is French and shown to the user;
 * it never contains the page itself (rule 2).
 */
export type ReadFailureReason =
  /** The input is not a listing we can read. */
  | 'unsupported'
  /** The platform blocks server reads (step 0): the seller must export the listing. */
  | 'server-read-blocked'
  /** Network error or timeout. */
  | 'network'
  /** Unexpected HTTP status. */
  | 'http'
  /** Captcha, challenge or block page. */
  | 'anti-bot'
  /** Removed listing (404, 410, redirect elsewhere). */
  | 'expired'
  /** Page served without the listing's data. */
  | 'no-data'
  /** The page or export is about another listing than the URL. */
  | 'wrong-listing'
  /** A field the sheet requires is missing. */
  | 'missing-field'
  /** Export file or sheet file that is not in the expected format. */
  | 'invalid-input';

export class ReadError extends Error {
  override readonly name = 'ReadError';

  constructor(
    readonly platform: string,
    readonly reason: ReadFailureReason,
    message: string,
  ) {
    super(message);
  }
}
