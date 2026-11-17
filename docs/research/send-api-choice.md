# Choosing a transactional send API for outbound mail

**Ticket:** [deanjstone/argus#112](https://github.com/deanjstone/argus/issues/112) — wayfinder research, child of [#111](https://github.com/deanjstone/argus/issues/111) (Map: Argus Email Inbox, Cloudflare-native)

**Question:** Which transactional send API should back outbound mail for an Argus agent email subsystem (agents sending email to arbitrary human recipients — internal notifications, not bulk marketing)?

**Note on `docs/research/`:** this directory existed on disk in the worktree but was empty and untracked in git (`git ls-files docs/research/` returns nothing, no history). This file establishes it as a tracked convention.

---

## TL;DR

**Use Cloudflare's Email Sending REST API directly.** As of 2026 it is a genuinely distinct, newer product from the old `send_email` Worker binding's pre-verified-recipient restriction, and — critically — **it now supports sending to arbitrary, non-pre-verified recipients once the sending domain is onboarded**. That removes the one blocker that used to force a third-party ESP into this stack. No Resend/Postmark/SES needed. See "Decision" below for the full reasoning and a fallback if this turns out to be false in production.

---

## 1. Cloudflare Email Service: two distinct products

Per `~/.claude/skills/cloudflare-email-service/SKILL.md` (this repo's own skill) and Cloudflare's docs:

| Product | What it is | Recipient restriction |
|---|---|---|
| `send_email` Worker binding + legacy `EmailMessage`/MIME API | Original Cloudflare Email Routing "reply/forward" capability | Historically limited to verified destination addresses only (the restriction this ticket exists to route around) |
| **Email Sending** (REST API `POST /accounts/{account_id}/email/sending/send`, or the same `send_email` binding once a domain is "onboarded") | Newer (2025) transactional send product, separate onboarding flow (`wrangler email sending enable <domain>`) | **Sandboxed to verified addresses only until the sending domain completes DNS authentication (SPF/DKIM/DMARC via onboarding). After onboarding, arbitrary recipients are allowed immediately.** |

### Primary source citation — the key finding

From Cloudflare's Email Service docs (fetched from `https://developers.cloudflare.com/email-service/` and `https://developers.cloudflare.com/email-service/platform/limits/`, August 2026):

> "Before you onboard a sending domain, you can send emails only to verified destination addresses in your account. After you onboard a sending domain, you can send to any recipient immediately."

And on abuse prevention during that pre-onboarding window:

> "New accounts start with a conservative daily quota and scale up over time based on your sending behavior, deliverability rates, and account standing." (rate-limit specifics not published; use the Limit Increase Request Form for more headroom)

This confirms the REST API spec (`https://developers.cloudflare.com/api/resources/email_sending/`) itself: the `send` method schema has no `allowed_destination_addresses`-style recipient allow-list parameter, and the field docs contain no recipient-verification requirement — consistent with "arbitrary recipients once onboarded."

Contrast with the Workers binding's *own* documented error code (`references/sending.md` in the skill, and Cloudflare's error reference):

```
E_RECIPIENT_NOT_ALLOWED | Recipient not in allowed list | Add to allowed_destination_addresses
```

This error is scoped to bindings still in sandbox (pre-domain-onboarding) or explicitly restricted via `allowed_sender_addresses`/similar config — not a permanent ceiling on the product once the domain is onboarded.

**Practical implication:** onboard the sending domain (`npx wrangler email sending enable yourdomain.com`, DNS records added, standard SPF/DKIM/DMARC verification) once, then Argus agents can email arbitrary humans — no third-party ESP account, API key, or vendor relationship required at all.

---

## 2. Pricing (Cloudflare Email Sending)

Source: `https://developers.cloudflare.com/email-service/platform/pricing/` (August 2026):

- Requires **Workers Paid plan** ($5/mo base, which Argus already needs for Workers/D1/etc.)
- **3,000 emails/month included**, then **$0.35 per 1,000 emails**
- Sends to *verified* destination addresses within the account are free and don't count against quota
- Message size 5 MiB general / 25 MiB to verified addresses; 50 recipients max combined to/cc/bcc

At "low hundreds per month" internal-notification volume, this is **$0/incremental** — it fits inside the included 3,000/month allotment entirely.

---

## 3. Comparison matrix

| | **Cloudflare Email Sending** | **Resend** | **Postmark** | **AWS SES** |
|---|---|---|---|---|
| Arbitrary-recipient sending (hard requirement) | Yes, after domain onboarding ([docs](https://developers.cloudflare.com/email-service/)) | Yes, no sandbox restriction on paid or free tier | Yes, no sandbox restriction | **No by default** — new accounts start in sandbox, restricted to *verified* recipients + 200/day + 1 msg/sec, until a manual "production access" request is approved (can take hours–days) |
| Pricing at ~low-hundreds/mo | **$0** (within 3,000/mo included, Workers Paid plan) ([pricing](https://developers.cloudflare.com/email-service/platform/pricing/)) | Free tier: 3,000/mo, 100/day cap; cheapest paid $20/mo for 50k ([pricing](https://resend.com/pricing)) | No real free tier (100/mo trial only); cheapest paid $15/mo for 10,000 ([pricing](https://postmarkapp.com/pricing)) | Cheapest at scale (~$0.10–0.16/1,000) but no free tier and sandbox friction dominates at low volume ([pricing](https://aws.amazon.com/ses/pricing/)) |
| Workers-stack DX / SDK quality | Native — Worker binding or REST, zero extra deps, generated types via `wrangler types`, official skill/docs in this repo | Excellent — official Workers-compatible fetch-based SDK, TS-first, widely used in the Workers community | Good REST API, mature client libraries, but not Workers-idiomatic (Node-oriented SDK) | Poor for Workers: needs SigV4 request signing (`aws4fetch` or similar) since the official AWS SDK is Node-oriented and heavy; extra complexity to run on `workerd` |
| Deliverability reputation | New product (2025+), reputation still building; Cloudflare's network-wide sending IPs, no independent third-party deliverability track record yet | Strong, purpose-built for developers, good reputation reports | Industry-leading — Postmark's whole positioning is deliverability-first, dedicated to transactional (never mixes marketing traffic on shared pools) | Strong at scale when configured correctly (dedicated IPs, warm-up), but reputation is what you make of it — no default guardrails |
| Integration friction (Cloudflare Workers backend) | None — same platform, one binding, no separate vendor account/API key/billing relationship | Low — one API key, one fetch call | Low — one API key, one fetch call | High — sandbox-to-production approval process, SigV4 signing, separate AWS account/IAM setup |

---

## 4. Decision

**Pick: Cloudflare Email Sending (REST API), Workers-native, no third-party ESP.**

Reasons, in order of weight:

1. **It satisfies the hard requirement (arbitrary recipients) without adding a vendor.** This is the single biggest finding of this research: the old assumption that Cloudflare could only email pre-verified addresses is now false for the *Email Sending* product specifically, once the domain is onboarded. That eliminates the entire premise of "which third party do we add" — the answer can be "none."
2. **It's free at Argus's actual volume.** Internal agent notifications are low-hundreds/month; that's fully inside Cloudflare's 3,000/month included allotment on the plan Argus already pays for. Every competitor either has a smaller free tier (Resend's 100/day cap is close to fine but adds a vendor and a second dashboard/account to manage for zero benefit) or no meaningful free tier at all (Postmark, SES).
3. **Zero integration friction.** No new API key, no new billing relationship, no SigV4 signing, no separate account to secure/rotate secrets for. One `wrangler email sending enable` + one binding or REST call, fully inside the Cloudflare account Argus already operates in. This directly matches the "Cloudflare-native" framing of the parent map issue (#111).
4. **AWS SES is disqualified outright at this volume** by its sandbox restriction (verified-recipients-only until manual production-access approval) — that reintroduces exactly the blocker this ticket exists to solve, just on a different vendor.

**Runner-up / fallback:** If in practice Cloudflare's Email Sending deliverability reputation proves inadequate (it's a newer product with less of a track record than Postmark specifically), **Postmark** is the fallback — not Resend, not SES — because deliverability is the whole point of routing agent notifications to a human inbox reliably, and Postmark's reputation is the strongest of the three third parties reviewed. This would only be worth revisiting after observing real bounce/spam-complaint data from the Cloudflare-native path in production.

**Do not use AWS SES** for this use case: the sandbox-to-production approval process reintroduces the "can only email verified addresses" problem this ticket exists to escape, and its Workers integration story (SigV4 signing via a third-party shim like `aws4fetch`) is the worst DX of the four options.

---

## Sources

- `~/.claude/skills/cloudflare-email-service/SKILL.md` and its `references/sending.md`, `references/rest-api.md` (this repo's skill set)
- https://developers.cloudflare.com/email-service/
- https://developers.cloudflare.com/email-service/platform/pricing/
- https://developers.cloudflare.com/email-service/platform/limits/
- https://developers.cloudflare.com/api/resources/email_sending/
- https://resend.com/pricing
- https://postmarkapp.com/pricing
- https://aws.amazon.com/ses/pricing/
