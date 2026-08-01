const TITLE = 'Error codes — FYLO'
document.title = TITLE

export default class extends Tac {
    constructor(props = {}, tac = undefined) {
        super(props, tac)
        if (this.isBrowser) document.title = TITLE
    }

    codes = [
        {
            code: 'EBADREQUEST',
            meaning: 'The request shape, field types, access object, or page options are invalid.',
            retry: 'Do not retry; fix the request.'
        },
        {
            code: 'EUNSUPPORTEDOP',
            meaning: 'The operation is unknown to this runtime.',
            retry: 'Do not retry; check the handshake capabilities.'
        },
        {
            code: 'EINVALIDDOCID',
            meaning: 'The supplied document ID is not a valid TTID.',
            retry: 'Do not retry; fix the ID.'
        },
        {
            code: 'EARRAYOFOBJECTS',
            meaning: 'The document contains an array of objects, which the data model rejects.',
            retry: 'Do not retry; restructure the document.'
        },
        {
            code: 'EACCES',
            meaning: 'The access context is not permitted to perform the operation.',
            retry: 'Do not retry with the same identity.'
        },
        {
            code: 'EDECRYPTFAILED',
            meaning: 'An $encrypted field could not be decrypted with the configured key.',
            retry: 'Do not retry; fix the key configuration.'
        },
        {
            code: 'EINVALIDCURSOR',
            meaning: 'The pagination cursor is invalid, expired, or from another process.',
            retry: 'Restart the traversal from page one.'
        },
        {
            code: 'EROOTLOCKED',
            meaning: 'Exclusive root ownership was unavailable — another process holds the lease.',
            retry: 'Fail over per your supervisor policy.'
        },
        {
            code: 'EROOTLEASELOST',
            meaning: 'Exclusive root ownership was lost after it had been acquired.',
            retry: 'Fail over per your supervisor policy.'
        },
        {
            code: 'EFRAME_UTF8',
            meaning: 'The request frame was not valid UTF-8.',
            retry: 'Fix the encoder; the loop resumes at the next frame.'
        },
        {
            code: 'EFRAME_JSON',
            meaning: 'The request frame was not a well-formed JSON object.',
            retry: 'Fix the request; the loop resumes at the next frame.'
        },
        {
            code: 'EFRAME_DUPLICATE_KEY',
            meaning: 'The request frame contained a duplicate object key.',
            retry: 'Fix the request; the loop resumes at the next frame.'
        },
        {
            code: 'EFRAME_REQUEST_TOO_LARGE',
            meaning: 'The request exceeded the negotiated maximum request size.',
            retry: 'Split the work or raise the limit at startup.'
        },
        {
            code: 'EFRAME_RESPONSE_TOO_LARGE',
            meaning: 'An unpaged response would exceed the negotiated maximum response size.',
            retry: 'Use a paged query on a persistent loop.'
        },
        {
            code: 'EFRAME_TRUNCATED',
            meaning: 'The final frame was incomplete at EOF; the loop ends.',
            retry: 'Retry only after starting a new child process.'
        },
        {
            code: 'EQUERYLOOPREQUIRED',
            meaning: 'The paged query contract requires a persistent loop.',
            retry: 'Reissue on a loop started with exec --loop.'
        },
        {
            code: 'EQUERYITEMTOOLARGE',
            meaning: 'A single query result item cannot fit inside the response frame.',
            retry: 'Do not retry; the document exceeds the frame contract.'
        },
        {
            code: 'EQUERYSNAPSHOTTOOLARGE',
            meaning: 'The query snapshot exceeded its 1 GiB storage cap.',
            retry: 'Narrow the query.'
        },
        {
            code: 'ENATIVE_IO',
            meaning: 'Native filesystem I/O failed, including disk pressure or xattr operations.',
            retry: 'Treat a mutation as ambiguous; inspect the cause before retrying.'
        },
        {
            code: 'EUNKNOWN',
            meaning: 'An engine failure without a more specific classification.',
            retry: 'Treat conservatively; inspect error.message diagnostically.'
        }
    ]
}
