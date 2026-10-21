# Questions for Telnyx support: knowledge bases for AI Assistants

Draft, 2026-10-20. Background: SPEC §18. Not sent yet. A portal spike on 2026-10-20 answered parts of 3, 5 and 9
(see `docs/telnyx-api-notes.md` §15). Questions 1, 3, 4 and 12 block the build; question 2 must be settled before we
reach the bucket limit.

---

**Subject:** Per-assistant knowledge bases (storage buckets, embeddings, retrieval tool)

Hi Telnyx team,

We run Easy Voice, a web app on a single Telnyx account. Each signed-up individual can rent one US local number and
set up to three Telnyx AI Assistants that answer and place calls for them. We'd like each assistant to have a small
knowledge base (typed notes, TXT/MD files, PDFs up to 4 MB, and at most one crawled website URL; up to 5 sources per
person) that it can consult during calls. Sources are never edited in place, only added or deleted, and a deletion
must be permanent. Our plan is one embedded storage bucket per assistant, attached with an inline
`{ "type": "retrieval", "retrieval": { "bucket_ids": [...] } }` tool. A few questions:

1. **Retention (blocking).** The Embedding & RAG pricing page says embedding "includes 30 days of retention" and that
   storage after 30 days is billed only when extended retention is enabled. What happens to a bucket's embeddings after
   30 days without extended retention: are they deleted, kept but unbilled, or disabled for retrieval? How do we turn
   on extended retention through the API, and what does it cost (per GiB, or a fixed fee per bucket or month)?
   Knowledge bases must keep working until the person deletes them.
2. **Bucket limit (blocking before we reach it).** Cloud Storage allows 100 buckets per account, and retrieval is
   scoped by bucket only. With one bucket per assistant we'd reach that at a few dozen users. Can you raise the limit
   for our account, and to what? Alternatively, can retrieval or similarity search be scoped within one bucket by
   object prefix or metadata, so that one person's documents never reach another person's calls? What error does
   bucket creation return at the limit?
3. **Crawled pages (blocking).** For `POST /v2/ai/embeddings/url`: how are crawled pages named in the bucket? We plan
   to allow one crawled URL per assistant and treat every object outside our own `src/` prefix as that crawl's pages.
   Can a crawled page ever be written under `src/`, or overwrite an existing object? Is there any upper bound on how
   many pages or bytes one crawl fetches, and can we limit it to one page, a depth or a page count? Can a crawl be
   cancelled? Does it respect robots.txt? If we delete a crawl's pages right after it finishes (for example because it
   returned more than 50 pages), are those pages still billed for embedding? What does a crawl that finds no pages
   report?
4. **Empty or broken buckets (blocking).** If an assistant's retrieval tool lists a bucket that is empty, still
   embedding, disabled for AI, or deleted: does creating or updating the assistant fail, does the call fail to start
   (`call.conversation.start_failed`), or does retrieval just return nothing? We need the call itself to go ahead
   either way.
5. **`bucket_ids` and default tools.** Your embeddings tutorial passes the bucket name in `bucket_ids`; can you
   confirm that is the intended value? What are the default and maximum for `max_num_results`? Which tools does an
   assistant created through `POST /v2/ai/assistants` without `tools` get by default (for example `hangup`)? Once we
   send `tools`, we'll send those defaults explicitly along with the retrieval tool.
6. **Retrieval during calls.** On a phone call, does the LLM decide to call the retrieval tool, or are chunks added to
   every turn automatically? What latency does a lookup add? Does it work reliably with every model our assistants can
   use (`moonshotai/Kimi-K2.6` by default; users can also pick other assistant-recommended models such as
   `zai-org/GLM-5.3-Flash`, `openai/gpt-5.4-mini` and `anthropic/claude-haiku-4-5`)? Are any assistant-recommended
   models unable to use it? Do lookups and the returned chunks appear in the conversation messages API?
7. **Tool API.** The create-assistant reference marks inline `tools` as deprecated, while the Tools Library page says
   legacy tools remain functional and all tool types are supported in the library. Can a `retrieval` tool be created
   as a shared tool through the API? Is there a date after which inline retrieval tools stop working?
8. **Pricing.** Is retrieval during calls covered by the $0.05/min voice engine rate, or billed as a similarity search
   ($0.003 each after 10,000 free per month)? Is embedding with `intfloat/multilingual-e5-large` billed at $0.0015 per
   1K characters? Is there a limit on the characters embedded from one document (a compressed PDF can hold far more
   text than its file size suggests)? Is an embedded bucket billed at the AI-embedded storage rate ($0.60/GiB-month)
   from day one?
9. **Setting up a bucket.** Can `POST /v2/ai/embeddings` run on an empty bucket, so that files we add later are
   embedded automatically? If a bucket's first content comes from `POST /v2/ai/embeddings/url`, do we still need
   `POST /v2/ai/embeddings`? What does creating a bucket that we already own return?
10. **File types and sizes.** Your docs say files other than PDF, HTML, TXT, JSON and CSV are treated as unstructured
    text. Is there a size limit for document files? Are scanned PDFs (images only) processed with OCR, and if not, what
    status and `error_reason` does such a file get?
11. **Languages.** Is `intfloat/multilingual-e5-large` the right model for English and Mandarin documents queried in
    either language? Is the embedding model fixed per bucket once chosen?
12. **Status and deletion (blocking).** What values can the per-file status in
    `GET /v2/ai/embeddings/buckets/{bucket_name}` take? Is there a webhook when embedding finishes? When we delete an
    object, are its embeddings removed right away, so that retrieval stops returning its content? Does Telnyx keep any
    copy of deleted objects, their embeddings, or crawl results (object versioning, backups, a recovery period, crawl
    task records), and for how long? We tell our users that deleting a source is permanent. To delete a bucket for good
    (and free the slot under the bucket limit), must we first disable AI for it (the "Disable AI for an Embedded
    Bucket" endpoint) and delete every object, and in which order?

Thanks!
