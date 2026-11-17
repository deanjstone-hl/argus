# Do Anthropic's terms permit a Claude subscription as a third-party app's model backend?

Research findings for [argus#305](https://github.com/deanjstone/argus/issues/305) (child of [#303](https://github.com/deanjstone/argus/issues/303)).

**Question.** What do Anthropic's terms permit regarding use of Claude Code / Claude subscription
authentication as a **generic model backend for a third-party application**, as distinct from using
it as a coding agent?

**Scope.** Terms only. The technical mechanism is [#304](https://github.com/deanjstone/argus/issues/304).
This document is not legal advice. Every quotation below is reproduced verbatim from the linked
primary source and marked as a quote; everything under a *Reading* heading is my interpretation and
should be treated as such.

**Sources retrieved.** 2026-08-25. All Anthropic terms pages carry effective dates; documentation
and help-centre pages carry either an update line or none, and are noted where relevant.

---

## 1. The governing documents, and which one applies

Anthropic operates two top-level contracts and routes Claude Code to one or the other by plan.

> Your use of Claude Code is subject to:
>
> * [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) - for Team, Enterprise, and Claude API users
> * [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) - for Free, Pro, and Max users

— [Claude Code, *Legal and compliance* → License](https://code.claude.com/docs/en/legal-and-compliance)

The Consumer Terms confirm the split from their own side:

> Please note: Our Commercial Terms of Service govern your use of any Anthropic API key, the
> Anthropic Console, or any other Anthropic offerings that reference the Commercial Terms of
> Service. For clarity, this does not include Claude.ai or Claude Pro use for individuals or
> entities.

— [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms), preamble
(Effective October 8, 2025)

**Reading.** A Pro or Max seat driving Claude Code sits under the **Consumer Terms**. This matters,
because the two contracts differ on exactly the point at issue — see §5.

---

## 2. Consumer Terms of Service — the clauses that bear on this

[Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms), Effective October 8, 2025.

### 2.1 The automated-access clause (§3)

Section 3 opens by defining Permitted Use, and this lead-in matters as much as the bullets:

> You may access and use our Services only in compliance with our Terms, including our Acceptable
> Use Policy, the policy governing the countries and regions Anthropic currently supports
> ("Supported Regions Policy"), and any **guidelines or supplemental terms we may post on the
> Services** (the "Permitted Use"). You are responsible for all activity under the account through
> which you access the Services.

(emphasis added)

Then, from the list of prohibited uses:

> You may not access or use, or help another person to access or use, our Services in the following
> ways: […]
>
> Except when you are accessing our Services via an Anthropic API Key or where we otherwise
> explicitly permit it, to access the Services through automated or non-human means, whether through
> a bot, script, or otherwise.

Also in the same list:

> To develop any products or services that compete with our Services, including to develop or train
> any artificial intelligence or machine learning algorithms or models or resell the Services.

> To crawl, scrape, or otherwise harvest data or information from our Services other than as
> permitted under these Terms.

> To decompile, reverse engineer, disassemble, or otherwise reduce our Services to human-readable
> form, except when these restrictions are prohibited by applicable law.

And the closing sentence of §3:

> You also must not abuse, harm, interfere with, or disrupt our Services, including, for example,
> introducing viruses or malware, spamming or DDoSing Services, or bypassing any of our systems or
> protective measures.

**Reading.** The automated-access bullet is the load-bearing clause for this question, and it is
*facially* broad enough to cover any script that invokes Claude on subscription auth — including
`claude -p` in a shell script. But it is not absolute. It carries two carve-outs: access via an API
key, **or** "where we otherwise explicitly permit it". Whether driving the CLI programmatically is
"explicitly permitted" is decided entirely outside this document — by the supplemental terms and
guidelines that §3's lead-in incorporates by reference, i.e. the Claude Code documentation (§3
below). So the Consumer Terms alone do not answer the question; they delegate it.

### 2.2 The credential clause (§2)

> You may not share your Account login information, Anthropic API key, or Account credentials with
> anyone else. You also may not make your Account available to anyone else. You are responsible for
> all activity occurring under your Account […]

**Reading.** This is about *sharing with another person*. A single user's own local application
reading their own credential is not a person-to-person share, so §2 does not by itself bite on
single-user use. It does bite hard on anything distributed to others that handles their
credentials — see §3.2.

---

## 3. Claude Code's own supplemental terms — this **is** addressed explicitly

This is the decisive document, and it is the one most likely to be missed: the question is *not*
unaddressed. The [Claude Code *Legal and compliance*](https://code.claude.com/docs/en/legal-and-compliance)
page contains a section written for precisely this scenario.

### 3.1 Acceptable use

> Claude Code usage is subject to the [Anthropic Usage Policy](https://www.anthropic.com/legal/aup).
> Advertised usage limits for Pro and Max plans assume **ordinary, individual usage** of Claude Code
> and the Agent SDK.

(emphasis added)

### 3.2 Authentication and credential use

Quoted in full, because the internal structure of this passage is where the answer lives:

> Claude Code authenticates with Anthropic's servers using OAuth tokens or API keys. These
> authentication methods serve different purposes:
>
> * **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team,
>   and Enterprise subscription plans and is designed to support ordinary use of Claude Code and
>   other native Anthropic applications. […]
> * **Developers** building products or services that interact with Claude's capabilities, including
>   those using the [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), should use API
>   key authentication through [Claude Console](https://platform.claude.com/) or a supported cloud
>   provider. Anthropic does not permit third-party developers to offer Claude.ai login into their
>   own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of
>   their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials
>   or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.
>
> This does not restrict how customers provision and manage their own API keys or third-party
> inference provider credentials — for example, configuring an API key in a development environment,
> secrets manager, or machine image for use by the customer's own authorized users — provided the
> resulting usage is billed to the key owner under their agreement with Anthropic (or the applicable
> provider) and is not resold or intermediated as described above. **Nor does it prevent an end user
> from signing in to the unmodified Claude Code binary with their own Claude subscription**, including
> where a platform hosts Claude Code as described under *Can customers offer Claude Code in their
> products?* above.
>
> Anthropic reserves the right to take measures to enforce these restrictions and may do so without
> prior notice.

(emphasis added)

### 3.3 The conditions on embedding Claude Code in a product

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or
> services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our
> Commercial Terms of Service and complying with the conditions below:
>
> * **The Claude Code binary must not be modified.** Claude Code must be installed and run as
>   published by Anthropic, and customers may not remove, disable, or restrict any authentication
>   method built into it (including methods that permit signing in with a Claude account or the
>   user's own API key).
> * **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.**
>   Each end user must authenticate with their own Anthropic API key, Claude subscription plan
>   credentials, or 3P inference provider credential […]

### 3.4 The same rule, restated in the Agent SDK docs

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai
> login or rate limits for their products, including agents built on the Claude Agent SDK. Use the
> API key authentication methods described in the Quickstart instead.

— [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

And on which contract governs the SDK:

> Use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service, including when
> you use it to power products and services that you make available to your own customers and end
> users […]

— *ibid.*, License and terms

**Reading — and this is the crux.** Every prohibition in §3.2 and §3.3 is written about a
**developer acting for other people**. Parse the operative sentences by their objects:

| Prohibited act | Who it is done *to* |
|---|---|
| "offer Claude.ai login into their own applications" | the developer's users |
| "route requests through Free, Pro, or Max plan credentials" | "**on behalf of their users**" |
| "collect, store, or intermediate Claude.ai credentials or session tokens" | someone else's credentials |
| "pay for, resell, or intermediate Claude usage" | "**on their end users' behalf**" |

None of these has an object when the developer, the account holder, and the sole end user are the
same person. And the passage then says the opposite in terms: it does **not** "prevent an end user
from signing in to the unmodified Claude Code binary with their own Claude subscription."

So the shape of the restriction is not *"a subscription may only drive a coding agent"*. It is
*"a subscription may only be driven by its own owner, through Anthropic's own unmodified client and
sign-in flow, and no one may intermediate it for anyone else."* The coding/generic distinction that
the ticket asks about is, on the face of these documents, **not the axis Anthropic drew the line
on.** Anthropic drew it on *whose subscription, whose client, and who handles the token*.

Two brakes on that reading, both real:

1. **"ordinary, individual usage"** (§3.1) and "ordinary use of Claude Code and other native
   Anthropic applications" (§3.2) are undefined qualifiers that plainly *can* be read to import a
   purpose limit. A backend for an unrelated app is not obviously "ordinary use of Claude Code."
2. §3.2's second bullet opens by telling **developers** — flatly, with no "for their users"
   qualifier — that they "should use API key authentication." "Should" is advisory, not
   prohibitory, and the binding sentences that follow are the ones qualified by "on behalf of their
   users". But it signals direction of travel.

---

## 4. The counterweight: Anthropic's own help centre contemplates exactly this

This materially complicates any confident "prohibited" reading, and it post-dates the legal page's
February 2026 tightening (§6).

[*Use the Claude Agent SDK with your Claude plan*](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
Anthropic Help Center, page dated **June 16, 2026**. Its current banner:

> **Update June 15:** We're pausing the changes to Claude Agent SDK usage described below. For now,
> nothing has changed: Claude Agent SDK, `claude -p`, and **third-party app usage still draw from
> your subscription's usage limits.** The previously announced monthly credit, which would have been
> available to eligible claimants in connection with these changes, isn't available. We're working
> to update the plan to better support how users build with Claude subscriptions. When we have an
> update, we'll share it before anything takes effect.

(emphasis added)

The paused-but-preserved body describes what the credit *would* have covered:

> The Agent SDK monthly credit applies to:
>
> * Claude Agent SDK usage in your own projects (Python or TypeScript)
> * The `claude -p` command in Claude Code (non-interactive mode)
> * The Claude Code GitHub Actions integration
> * **Third-party apps that authenticate with your Claude subscription through the Agent SDK**

(emphasis added)

And, on where the line sits between personal and production use:

> The Agent SDK monthly credit is sized for individual experimentation and automation. Teams running
> shared production automation should use Claude Platform with an API key for predictable
> pay-as-you-go billing.

**Reading.** Anthropic's own billing documentation treats "third-party apps that authenticate with
your Claude subscription" as a **live, metered, ordinary usage category** — something to be priced,
not something to be stopped. You do not design a credit product for conduct you prohibit. The same
list also confirms that `claude -p` on subscription auth is a recognised and expected pattern, and
the closing sentence draws the boundary at *individual experimentation and automation* versus
*shared production automation* — which is the personal/redistributed axis, not the coding/generic
axis.

This does not repeal the legal page. A help-centre billing article is weaker authority than a
supplemental-terms page, and the two can be reconciled: the legal page bans developers
*intermediating other people's* subscriptions, while the help article describes an end user
authenticating *their own*. That reconciliation is coherent — but it is my reconciliation of two
first-party documents that do not cross-reference each other, and a reader starting from the legal
page alone would reasonably reach a stricter conclusion.

### 4.1 Anthropic also documents programmatic CLI use directly

The [*Run Claude Code programmatically*](https://code.claude.com/docs/en/headless) page presents
`claude -p` for build scripts, CI, piping arbitrary stdin through Claude, and replacing the system
prompt (`--system-prompt`, `--append-system-prompt`) — i.e. use as a general text-processing
backend, not only as a coding agent. It imposes no auth restriction on ordinary `-p`, and the only
auth statement it makes is about the opt-in `--bare` flag:

> Set `ANTHROPIC_API_KEY` before running it, because bare mode doesn't use your subscription login.

> In bare mode, Claude Code never reads OAuth credentials or the system keychain.

**Reading.** The necessary implication of "bare mode doesn't use your subscription login" is that
**non-bare `claude -p` does** — stated by Anthropic, in the page whose entire subject is running
Claude Code programmatically. Combined with §2.1's "where we otherwise explicitly permit it"
carve-out, this is the strongest available argument that scripted CLI invocation on a subscription
is permitted rather than caught by the automated-access clause.

---

## 5. The Commercial Terms, for contrast

[Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), Effective June 17, 2025:

> **A.1. Overview.** Subject to these Terms, Anthropic gives Customer permission to use the
> Services, **including to power products and services Customer makes available to its own customers
> and end users** ("Users").

(emphasis added)

> Customer may not and must not attempt to (a) access the Services to build a competing product or
> service, including to train competing AI models or resell the Services except as expressly
> approved by Anthropic; (b) reverse engineer or duplicate the Services; or (c) support any third
> party's attempt at any of the conduct restricted in this sentence.

**Reading.** The Commercial Terms contain the affirmative grant that the Consumer Terms lack — an
express right to power your own products with the Services. Its absence from the Consumer Terms,
combined with the Consumer Terms' automated-access prohibition, is the clearest structural signal
in the whole corpus: **the "build a product on it" permission lives on the API/Commercial side, and
was not extended to the consumer side.**

---

## 6. Usage Policy, and the history of the current wording

[Usage Policy](https://www.anthropic.com/legal/aup), Effective September 15, 2025. Under *Do Not
Abuse our Platform*:

> Coordinate malicious activity across multiple accounts to avoid detection or circumvent product
> guardrails […]

> Utilize automation in account creation or to engage in spammy behavior

> Circumvent a ban through the use of a different account […]

> Intentionally bypass capabilities, restrictions, or guardrails established within our products for
> the purposes of instructing the model to produce harmful outputs (e.g., jailbreaking or prompt
> injection) without prior authorization from Anthropic

> Utilization of inputs and outputs to train an AI model (e.g., "model scraping" or "model
> distillation") without prior authorization from Anthropic

**Reading.** The Usage Policy is about *content and abuse*, not architecture. Nothing in it prohibits
a personal application calling Claude. It adds no independent restriction here. (Note in passing,
for §7: it does prohibit conduct that "circumvent[s] the guardrails or terms of **other** platforms
or services.")

### 6.1 The February 2026 change, and Anthropic's characterisation of it

The *Authentication and credential use* section is recent. It was added to the Claude Code legal page
around **17–18 February 2026** — the date is corroborated by a contemporaneous third-party issue
filed against a tool that the change affected
([AndyMik90/Aperant#1871](https://github.com/AndyMik90/Aperant/issues/1871), opened
2026-02-18T19:57Z, quoting the then-current text) and by press coverage the same week
([The Register, 2026-02-20](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)).
Both are **secondary** sources and are cited only for dating and for the prior wording; I was unable
to date the change from a first-party source, because the docs site renders client-side and Wayback
snapshots of the page contain no body text.

Two things from that record are material:

1. **The wording has since softened.** The February version quoted in the GitHub issue read:
   *"OAuth authentication (used with Free, Pro, and Max plans) is intended exclusively for Claude
   Code and Claude.ai. Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any
   other product, tool, or service — including the Agent SDK — is not permitted and constitutes a
   violation of the Consumer Terms of Service."* That categorical sentence — which would have
   answered this ticket outright, against the proposal — **is not in the live page today.** What
   replaced it is the narrower, "on behalf of their users"-qualified text quoted in §3.2. I could
   not independently verify the February wording from a first-party source; treat it as
   well-corroborated but secondary.
2. **Anthropic frames the rule as pre-existing, not new.** Per The Register, Anthropic described the
   update as making its documentation "consistent throughout", and an Anthropic engineer is quoted:
   *"Third-party harnesses using Claude subscriptions create problems for users and are prohibited
   by our Terms of Service."* Enforcement — server-side blocking of third-party clients presenting
   subscription OAuth — is reported to have begun in January 2026, before the doc change.

**Reading.** Point 2 is the single most important cautionary fact in this document. Anthropic's own
position is that the automated-access clause **already prohibited** third-party harnesses on
subscription auth, and that the February text merely said so out loud. Under that reading the
softening in point 1 is a drafting cleanup, not a concession. Point 1 nonetheless remains
significant: the operative text today is qualified, and terms are construed as written, not as their
author later says they meant.

---

## 7. Comparison only: the `pssah4/vault-operator` ChatGPT-OAuth precedent

The ticket asks whether the shipped Obsidian plugin
[`pssah4/vault-operator`](https://github.com/pssah4/vault-operator), which drives a user's ChatGPT
Plus/Pro subscription through OpenAI's Codex endpoint, is **sanctioned precedent** or **someone
else's accepted risk**. Per the ticket's instruction, nothing in this section informs the Anthropic
conclusion.

**What it does.** From the plugin's own architecture doc
([`docs/concepts/provider-auth.md`](https://github.com/pssah4/vault-operator/blob/main/docs/concepts/provider-auth.md)):

> `ChatGptOAuthService` […] runs the PKCE loopback flow used by the Codex CLI. […] Requests then
> route to `chatgpt.com/backend-api/codex/responses` (the Codex Responses API) instead of the public
> `api.openai.com` `/chat/completions` endpoint. […] ChatGPT-OAuth bills against your existing Plus
> or Pro subscription, not a per-token API key.

Its source confirms it authenticates **as the Codex CLI**, using that client's public OAuth client
ID (`app_EMoamEEZ73f0CkXaXp7hrann`, in `src/core/auth/ChatGptOAuthService.ts`), against
`auth.openai.com`.

**Is it sanctioned? No.**

- OpenAI's **actual** third-party subscription-identity programme is *Sign in with ChatGPT*, launched
  as a live beta in early August 2026 with a small set of named launch partners and an application
  form. vault-operator is not in it and does not use it.
- OpenAI's Codex documentation names exactly two supported sign-in methods and points automation at
  API keys: *"Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs"*
  ([Codex → Authentication](https://learn.chatgpt.com/docs/auth)). It says nothing permitting a
  non-OpenAI client to present ChatGPT OAuth against the Codex backend.
- The endpoint used is an undocumented internal one, not a published API surface.
- Anthropic's own Usage Policy, incidentally, prohibits conduct that "circumvent[s] the guardrails or
  terms of other platforms or services" — so the practice would not become safe merely by analogy.

**But OpenAI's posture is genuinely more permissive, and that is a real difference, not a rounding
error.** Three concrete points, all first-party:

1. OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use/) (Effective January 1, 2026)
   contain **no general prohibition on automated or programmatic access.** The nearest clauses are
   *"Automatically or programmatically extract data or Output"* — extraction/scraping, not
   invocation — and *"circumvent any rate limits or restrictions or bypass any protective measures."*
   Anthropic's equivalent clause bans automated **access** outright absent an API key or explicit
   permission. That asymmetry is the whole difference between the two ecosystems on this question.
2. OpenAI's own Codex docs **document copying the subscription credential** (`~/.codex/auth.json`)
   to remote hosts and into Docker containers, and link a guide to *"Maintain Codex account auth in
   CI/CD (advanced)"* — while still saying *"API keys are still the recommended default for
   automation."* Anthropic publishes no comparable guidance.
3. OpenAI has, at least once, publicly blessed a specific third-party agent on subscription auth
   (Sam Altman on OpenClaw: *"you can sign in to openclaw with your chatgpt account now and use your
   subscription there!"* — reported [here](https://thenextweb.com/news/openai-openclaw-chatgpt-subscription-agent);
   secondary source). That is a *named* blessing, not a general licence, and it is the exception that
   demonstrates the rule: absent such a blessing or the Sign in with ChatGPT programme, third-party
   subscription auth is unsanctioned.

**Conclusion for §7: accepted risk, not precedent.** vault-operator ships a client impersonating the
Codex CLI against an undocumented endpoint, outside OpenAI's actual third-party programme. It is
evidence that the practice exists in the wild and is currently tolerated — which is a statement about
enforcement, not permission. It carries no weight for Anthropic, whose consumer terms are stricter on
the precise clause that matters.

---

## 8. Answers to the four questions asked

**(1) What the terms say.** Covered in §§2–6. The relevant instruments are the Consumer Terms §2 and
§3 (October 8, 2025), the Usage Policy (September 15, 2025, which adds nothing here), the Commercial
Terms A.1 (June 17, 2025, for contrast), and — decisively — the Claude Code *Legal and compliance*
supplemental terms, which Consumer Terms §3 incorporates by reference via "any guidelines or
supplemental terms we may post on the Services."

**(2) Is "Claude Code CLI as a backend for another app" addressed?** **Explicitly addressed — but
along a different axis than the question assumes.** It is not unaddressed, and it is not left to
implication. Anthropic has written directly about it since February 2026. What Anthropic prohibited,
however, is *developers routing other people's subscriptions and handling other people's
credentials*, not *what kind of task the model performs*. There is no clause anywhere in the corpus
that distinguishes coding work from non-coding work on a subscription seat. The "ordinary,
individual usage" qualifier is the only textual hook for a purpose limit, and it is undefined.

**(3) Does personal, single-user, non-redistributed use change the answer?** **Yes — decisively, and
it is the axis that actually matters.** Every operative prohibition in §3.2/§3.3 is scoped by "on
behalf of their users" / "on their end users' behalf" / "into their own applications", and the
passage expressly preserves "an end user … signing in to the unmodified Claude Code binary with their
own Claude subscription". §4's help-centre article independently draws the same line at "individual
experimentation and automation" versus "shared production automation". Redistribute an app that
authenticates other people's Claude subscriptions, or that collects/stores/intermediates their
tokens, and you land squarely inside an explicit prohibition. Keep it to one person driving their own
seat through Anthropic's own unmodified client, and no prohibition's subject-matter is engaged on the
face of the text.

**(4) The vault-operator comparison.** §7. Accepted risk, not precedent.

---

## 9. Verdict

**Genuinely grey — but the grey is not uniform. It resolves cleanly in two of three cases, and only
the third is actually grey.**

| Shape | Verdict | Basis |
|---|---|---|
| Ship an app to others that logs them into Claude, or that collects/stores/proxies their subscription tokens | **Clearly prohibited** | Claude Code legal §*Authentication and credential use*, both bullets; Agent SDK overview note; Consumer Terms §2 |
| Reimplement Claude Code's OAuth flow, modify the binary, or present subscription OAuth from a non-Anthropic client | **Clearly prohibited** | "sign-in … must complete through Anthropic's own flow"; "The Claude Code binary must not be modified"; Consumer Terms §3 (automated access, reverse engineering, bypassing protective measures). Also actively enforced server-side since January 2026 |
| One person, on their own seat, driving the **unmodified** official CLI that **they** signed into via Anthropic's own flow, for a personal, non-redistributed application — including non-coding tasks | **Genuinely grey** | See below |

**Why the third case is grey rather than either extreme.**

*Pointing toward permitted:*
- Every operative prohibition is scoped to acting on behalf of *other* users; with one person, those
  clauses have no subject matter.
- The legal page expressly does not "prevent an end user from signing in to the unmodified Claude
  Code binary with their own Claude subscription."
- Anthropic publishes, documents, and supports `claude -p` for scripts, CI, arbitrary stdin, and
  replaced system prompts, and states that non-bare mode uses the subscription login — which is
  plausibly the "where we otherwise explicitly permit it" carve-out to Consumer Terms §3.
- Anthropic's June 2026 help article treats `claude -p` and "third-party apps that authenticate with
  your Claude subscription" as a live, metered category it was preparing to *price*, and draws its
  own boundary at individual versus shared production automation.
- The categorical February 2026 sentence that would have banned this outright was removed.

*Pointing toward prohibited:*
- Consumer Terms §3's automated-access clause is facially broad, and the carve-out relied on above is
  an inference from documentation, not an express grant.
- "Ordinary, individual usage" and "ordinary use of Claude Code and other native Anthropic
  applications" are undefined and can be read to import a purpose limit that a generic model backend
  would fail.
- The Commercial Terms contain an express "power your own products" grant; the Consumer Terms
  conspicuously do not. That omission looks deliberate.
- Developers are told, without qualification, that they "should use API key authentication."
- Anthropic's stated position is that third-party harnesses on subscriptions were **always**
  prohibited and that February 2026 changed nothing — so the softened wording may not mean what it
  appears to concede.
- Anthropic "reserves the right to take measures to enforce these restrictions … without prior
  notice", and has already done so against other tools. **Enforcement risk here is account-level and
  practical, not merely theoretical** — and it does not depend on winning the interpretive argument.

**What I am not saying.** I am not saying this is safe, and I am not saying it is prohibited. The
honest position is that Anthropic has drawn a bright line around *intermediating other people's
subscriptions* and has left *one person's programmatic use of their own seat through the official
client* in a space it simultaneously documents as supported (headless docs, help-centre billing
categories) and describes with language that could be tightened against it at any time ("ordinary,
individual usage"), without notice, by editing a documentation page rather than a contract.

That last point is the one worth carrying into the decision: this sits on **supplemental terms
incorporated by reference from a docs site**, which Anthropic has already revised twice in six months
— once in a direction that would have killed the proposal outright, then partly back. Whatever is
built here should assume the terms can move under it, and should not be architecturally dependent on
the current wording holding.

The grey is real, it is narrow, and per the ticket it is the human's call, not mine.

---

## Source index

**Anthropic — primary**
- [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) — Effective October 8, 2025
- [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) — Effective June 17, 2025
- [Usage Policy (AUP)](https://www.anthropic.com/legal/aup) — Effective September 15, 2025
- [Claude Code — Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code — Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless)
- [Claude Agent SDK — overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Help Center — Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) — page dated June 16, 2026
- [Help Center — Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)

**OpenAI / vault-operator — primary (§7 only)**
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) — Effective January 1, 2026
- [Codex — Authentication](https://learn.chatgpt.com/docs/auth)
- [pssah4/vault-operator — `docs/concepts/provider-auth.md`](https://github.com/pssah4/vault-operator/blob/main/docs/concepts/provider-auth.md)
- [pssah4/vault-operator — `src/core/auth/ChatGptOAuthService.ts`](https://github.com/pssah4/vault-operator/blob/main/src/core/auth/ChatGptOAuthService.ts)

**Secondary — used only for dating and prior wording, flagged inline**
- [AndyMik90/Aperant#1871](https://github.com/AndyMik90/Aperant/issues/1871) — opened 2026-02-18, quotes the February wording
- [The Register, 2026-02-20](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/) — Anthropic's characterisation, enforcement timeline
- [The Next Web — OpenAI/OpenClaw](https://thenextweb.com/news/openai-openclaw-chatgpt-subscription-agent) — Altman quote
