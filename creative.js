/**
 * creative.js — The Creative Agent for the CFO Content Engine.
 *
 * Picks up every row in the DB with status='Idea', sends the topic to the
 * Gemini API with a persona-appropriate system prompt, and writes the
 * returned script (as strict JSON) back to `videos.script_json` with
 * status='Scripted'.
 *
 * Two personas with distinct voices, one shared set of global rules:
 *
 *   BUILDER  -> Financial System Architect for Salisbury Bookkeeping.
 *               Audience: anyone in the trades who wants to visualize their
 *               data — from small remodelers to large contractors with a
 *               CFO / controller in seat. No revenue floor or ceiling.
 *               Voice: "Contractor to Contractor", authoritative but
 *               accessible. Focus: job costing, margins, WIP/backlog
 *               reporting, connecting the field to the bank account.
 *
 *   SELLER   -> E-commerce Growth Partner.
 *               Focus: SKU-level profitability, COGS, multi-channel chaos.
 *
 * Global rules (both personas):
 *   - No corporate jargon. Ever.
 *   - Never use the phrase "At Salisbury".
 *   - Structure every script with Hormozi's direct-response framework:
 *         HOOK   -> grab attention in the first 3 seconds
 *         RETAIN -> keep the viewer watching (body)
 *         REWARD -> pay off the promise in the hook (body)
 *         CTA    -> one clear, specific next action
 *   - Visual prompts: high-end, photorealistic architectural or clean
 *     product b-roll ONLY. No people. No 3D renders / CGI / illustrations.
 *
 * Output schema enforced via Gemini's responseSchema + responseMimeType:
 *   { hook, body_text, call_to_action, visual_prompts: [string], landing_slug }
 *
 * Failure semantics: if Gemini errors for a given row, that row stays in
 * 'Idea' status. We never advance a row we couldn't actually script —
 * that's the whole point of the state machine (no wasted downstream credits).
 */

const https = require('node:https');
const db = require('./db');
const { withRetry, isTransientHttpError } = require('./retry');
const llm = require('./llm');

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Fallback chain when the primary is slammed with 503s. We try each in
// order on transient failure before the row gets a cooldown. Different
// models sit on different queue pools, so when flash is flooded the lite
// or 2.0 variants often respond in the same breath.
const GEMINI_MODEL_FALLBACKS = (process.env.GEMINI_MODEL_FALLBACKS
  || 'gemini-2.5-flash-lite,gemini-2.0-flash-001,gemini-flash-latest'
).split(',').map((s) => s.trim()).filter(Boolean);
const GEMINI_HOST    = 'generativelanguage.googleapis.com';
const GEMINI_TIMEOUT_MS = 45_000;

// Small delay between calls so we don't hammer the free tier.
const PER_ROW_DELAY_MS = 500;

// ~50-second read at ~130 wpm ≈ ~110 words total across hook+body+CTA.
// Bumped from 100 to 110 to fit the mandatory product mention + offer bundle
// (14-day trial, 30-day guarantee, dev access) without squeezing the joke.
const TARGET_WORDS = 110;

// Persona-specific product positioning used by the prompt + validator.
// Every script MUST mention its product name and anchor it to the same
// one-line positioning so viewers learn what it is across videos.
const PRODUCT = {
  BUILDER: {
    name: 'BuilderCFO',
    positioning: 'an easy dashboard tool that instantly shows which jobs make money and which ones are bleeding you',
  },
  SELLER: {
    name: 'SellerCFO',
    positioning: 'an easy dashboard tool that instantly shows which SKUs and channels make money and which ones are bleeding you',
  },
};

// The offer bundle that goes in every CTA. We rotate how these three bullets
// are phrased so the scripts don't all sound like a template, but all three
// MUST appear (enforced by the validator).
const OFFER_BUNDLE = [
  '14-day free trial',
  '30-day money-back guarantee',
  'direct access to the developer so we customize it to your setup',
].join(' · ');

// -----------------------------------------------------------------------------
// Prompt construction
// -----------------------------------------------------------------------------

const GLOBAL_RULES = `
GLOBAL RULES (apply to every script, no exceptions):

LENGTH & CADENCE (TTS-friendly):
- Target ~${TARGET_WORDS} words total across hook + body_text + call_to_action. That's a ~50-second read.
- Write for a voice model, not a page. Short sentences. 8–14 words max. Periods, not semicolons. Let the voice breathe.
- Second person. "You", "your crew", "your store". Never "one might" or "businesses should".
- A 45-second video with 70% completion crushes a 15-second video with 40% completion on every platform.
  We write to finish strong, not to cut short.

WRITE FOR TEXT-TO-SPEECH (mandatory — the voice model reads this literally):
- SPELL OUT every number as words the way a human would say it out loud.
    $11,500          → "eleven thousand five hundred dollars"
    $8,473           → "eight thousand four hundred seventy three dollars"
    $3.10/unit       → "three dollars and ten cents per unit"
    62%              → "sixty-two percent"
    14-day           → "fourteen day"
    30-day           → "thirty day"
    $2M              → "two million dollars"
    #1               → "number one"
    3PL              → "three P L"
- NO ABBREVIATIONS or acronyms that a voice model will butcher. Spell them out:
    P&L              → "P and L"  (not "P-ampersand-L")
    WIP              → "work in progress" (the audience knows the term)
    GC               → "general contractor"
    ROAS             → "return on ad spend"
    FBA              → "F B A" (keep as letters, known)
    DTC              → "D T C"
    AOV              → "average order value"
    CPA              → "C P A"
- Pronunciation-first acronyms — write them as the SPOKEN form so ElevenLabs
  reads them as humans say them, not as spelled-out letters:
    SKU / SKUs       → write as "SKU" (spelling). The normalizer converts to "skew" / "skews"
                       at render time — DO NOT write "S-K-U" or "ess kay you".
    SaaS             → write as "SaaS". The normalizer converts to "sass".
    COGS             → write as "COGS". The normalizer converts to "cogs" (one syllable).
    FAQ              → write as "FAQ". The normalizer converts to "frequently asked questions".
- BRAND + PRODUCT names stay as-is (ElevenLabs pronounces them fine):
    BuilderCFO, SellerCFO, QuickBooks, Procore, Buildertrend, Sage, Shopify,
    Amazon, FBA, TikTok, Instagram, Etsy, Meta.
- Punctuation directs pacing. Use periods for hard stops, commas for beats,
  em-dashes — like this — for a sharp aside. Never semicolons or colons in
  the spoken fields; those don't render well in TTS prosody.
- If you find yourself writing "e.g.", "i.e.", "etc.", "vs." — STOP. Write
  "for example", "that is", "and so on", "versus". The voice reads letters literally.

PLATFORM RETENTION MATH (this is what the algorithm actually grades):
- TikTok: 70%+ completion is the viral push bar. The platform test-audiences every new video with 200–500
  viewers in the first 30–90 minutes; if 70%+ watch it through, it goes wide. Below 70%, it dies.
- Instagram Reels: DM sends-per-reach is the #1 distribution signal, saves are 3x likes,
  watch-through past the 3-second mark is gate #1. The video must be SEND-WORTHY to a specific friend.
- YouTube Shorts: "viewed vs. swiped-away" rate is the ranking core. Shorts are now a standalone
  discovery engine (decoupled from long-form), so every Short has to earn its view by itself.
- Across all three: the first 3 seconds decide distribution. Strong creators hit 65–70% at the 3s mark
  and get 4–7× more impressions than videos that leak viewers there. The HOOK is the whole game.

AI-CONTENT COMPLIANCE (2026 rules):
- TikTok, Meta, and YouTube all require AI-generated video/audio to be labeled. Unlabeled AI is being
  auto-labeled, demoted, or removed (TikTok removed 2.3M AI videos in Q1 2026 alone).
- Our voice is ElevenLabs and our images are Gemini — both are AI. Operator MUST toggle the AI-content
  label when uploading. Do NOT write scripts that claim "I recorded this" or imply a human demo.
- NEVER name a real person, real brand as an endorser, or imply celebrity/expert quotes we don't have.
  These triggers the financial-scam classifier and gets the video removed.

FUNNY FIRST — HORMOZI, BUT WITH JOKES (mandatory tonal direction):
- Your job is to articulate the viewer's pain BETTER than they can — but disguised inside a joke,
  a roast of the industry, or a bit of self-deprecation. Make them laugh first, then land the point.
- The comedy is observational and oddly specific. Never "lol" or emoji-mouth energy.
- Good joke textures: exaggerated absurdity, mundane-to-outrageous escalation, absurd analogies,
  gentle roast of "how we've all done it wrong", anthropomorphizing a spreadsheet or a bad SKU,
  noticing the weird thing nobody says out loud.
- Never use jokey crutches: NO "spoiler alert", NO "plot twist", NO "asking for a friend",
  NO "don't at me", NO "cue the music", NO "cries in [thing]".
- If a line isn't either funny OR painfully true, rewrite it.

PRODUCT MENTION (MANDATORY — one of these MUST appear):
- Every script must plug the persona's product by NAME and POSITIONING at least once inside body_text.
  Positioning is always framed as: "an easy dashboard tool that instantly shows which [jobs/SKUs] make
  money and which ones are bleeding you." Rephrase it naturally — don't paste it.
- Bend the joke into the product reveal. The product is the punchline's payoff, not a pitch wedged in.

OFFER BUNDLE (MANDATORY — must appear inside call_to_action):
- Every CTA must communicate all THREE of these, in any natural order, in the operator's own voice:
    (1) 14-day free trial
    (2) 30-day money-back guarantee
    (3) direct access to the developer to customize it to their setup
- The CTA must ALSO point the viewer to the pinned/first comment where we post the link ourselves.
  Natural phrasings: "link's pinned in the first comment", "tap the pin below", "link in the top comment",
  "comment at the top has the checklist". We post the link; the viewer doesn't type anything.
- Rotate CTA openers aggressively across videos. Never start every CTA the same way.

LANDING SLUG (MANDATORY separate field: "landing_slug"):
- Return a short kebab-case slug describing the exact resource the CTA promises. Examples:
  "margins", "wip", "landed-cost", "sku-kill-list", "3-min-margin-check", "true-margin-audit".
- This becomes both the URL path on salisburybookkeeping.com/go/{slug} AND the uppercase keyword
  viewers can comment to trigger the auto-DM bot (platform maps "MARGINS" → /go/margins).
- When the CTA uses the KEYWORD model, the keyword in speech MUST be the uppercase version of this
  slug (e.g. slug "wip" -> keyword 'WIP'). Compound slugs like "sku-kill-list" collapse to a short
  keyword in speech ("SKU"). The platform accepts both.
- Max 30 chars, lowercase, letters/numbers/dashes only, no leading/trailing dash, no spaces.
- Must semantically match what the script promised. Don't return a generic slug.

SEND-WORTHY + SAVE-BAIT (Reels/TikTok distribution multipliers):
- Instagram's #1 signal for non-follower reach is DM sends. Before shipping, ask: "Would a contractor
  text this to their partner who runs the finance side?" or "Would an operator send this to their
  co-founder who still thinks revenue = profit?" If no, the script is missing a shareable line.
- Include ONE line in the body that is quotable/sendable on its own — a clean punchline or numeric
  reveal someone would screenshot. ("A 62% margin on Shopify is doing CrossFit. After Meta, returns,
  and 3PL, it needs a cane.")
- End body or CTA with a SAVE cue when appropriate: "Save this for the next time you quote a job" —
  makes the viewer keep the video, which TikTok and Reels weight above likes.

FIRST-3-SECONDS VISUAL (critical — this is where 70% of videos die):
- visual_prompts[0] MUST be arresting in the first frame even before captions appear. A close-up on a
  tactile detail (a specific number on a screen, an object that says "this is about YOU"), not an
  establishing wide of a jobsite or warehouse.
- Works on MUTE: if the viewer scrolled with sound off, the first frame plus the burned-in caption
  must still communicate "this is about MY problem."

BANNED:
- Corporate jargon ("leverage synergies", "best-in-class", "solutions provider", "mission-critical", "unlock value", "stakeholders", "at scale", "holistic").
- The exact phrase "At Salisbury". Use "we" or "our team" if you need to.
- Hype adjectives with no substance ("game-changing", "revolutionary", "ultimate", "secret").
- Vague body copy. If you wouldn't say it to a friend on FaceTime, cut it.
- AI-tell phrases that make this sound like ChatGPT wrote it. Specifically banned:
    "Let's get this sorted", "we've got your back", "we got you",
    "here's the thing", "let me tell you", "listen,", "look,",
    "the reality is", "at the end of the day", "when it comes to",
    "in today's world", "here's what you need to know", "buckle up",
    "trust me", "believe me", "think about it", "let's dive in",
    "let's break it down", "let's unpack this", "the bottom line is",
    "plain and simple", "long story short", "the truth is".
  If you catch yourself starting a sentence with "Look," or "Listen,"
  — delete it and start with the next word.

HORMOZI DIRECT-RESPONSE STRUCTURE (required, not optional):
  HOOK (field: "hook")         First 2 seconds. Pattern-interrupt. Must pass the "MUTE TEST" — the
                                viewer should know the video is for them even if the sound is off,
                                because the first caption or visual already screamed it.
                                Pick ONE of these four hook formulas and make it unmistakable:

                                1. BOLD STATEMENT — challenge conventional wisdom with specificity.
                                    "Most contractors mistake 'cash in the bank' for 'a profitable year'."
                                    "Your 'profitable' job is profitable the way gas station sushi is sushi."

                                2. PROOF-FIRST — lead with a specific result, then tease the method.
                                    "I recovered $14,200 on one remodel by finding four line-items."
                                    "One SKU was losing this brand $3.10 a unit — for 11 months."
                                    (If you use a number, it must be specific and odd, never round.)

                                3. QUESTION HOOK — pain-point question the viewer can't answer yes/no.
                                    "Why does your 'most profitable job' fall apart once you add labor burden?"

                                4. PATTERN-INTERRUPT — an absurd-but-true comparison or weird-specific number.
                                    "You call it a P&L. Your CPA calls it fiction. Your banker calls it concerning."
                                    "If your job-costing lives on a truck-floor receipt, congrats — your accountant does archaeology."

                                SPECIFICITY RULE: if the hook can fit any contractor/operator, rewrite it. If
                                it can only fit the ONE person losing money in exactly the way this video
                                describes, ship it.

  RETAIN (first half of body)  Open the loop. Name the ONE framework / move / idea the video teaches
                                (e.g. "the 3-minute margin check"). Make a second joke on the way in —
                                don't let the energy drop between hook and reveal.
                                The FIRST BODY SENTENCE must restate the pain in the viewer's own words,
                                so they feel seen. Then pivot: "here's the move."

  REWARD (second half of body) Deliver the mechanic with ONE specific odd number AND ONE concrete step.
                                Not round ($8,500 is lazy; $8,473 lands). THEN mention the product by name +
                                positioning (see PRODUCT MENTION above) as the thing that does this
                                automatically. "Inside BuilderCFO you just see it sitting there on the
                                dashboard" beats "we built a tool that…".

  CTA (field: "call_to_action")  The offer bundle + delivery hook. Must include the 14-day trial, the
                                30-day money-back guarantee, and the direct-developer access.

                                DELIVERY HOOK — pick ONE, do not mix:
                                • KEYWORD MODEL (preferred when platform is IG Reels or YT Shorts):
                                    "Comment 'MARGINS' and my bot DMs you the worksheet in 10 seconds."
                                    Our platform auto-delivers via IG comment webhook + YouTube comment poll.
                                    Keywords MUST be SHORT, UPPERCASE, one word, already present in our
                                    content_campaigns table as the landing_slug. Examples: MARGINS, WIP,
                                    BURDEN, SKU, LANDED, TRUE.
                                • PIN MODEL (use when the script does not supply a keyword or targets TikTok):
                                    "Link's pinned in the first comment" / "Tap the pin below" — we post
                                    the landing URL ourselves. TikTok MUST use this model (no public comment API).

                                Do not stuff the offer bundle as a bulleted list — write it as a human.
                                Rotate openers. Never "book a call" / "learn more" / "subscribe".

DELIVERY TONE (TJ Robertson / authenticity beats polish):
- Write like you'd FaceTime a buddy who just asked for help. Not a keynote.
- Contractions always. "You're", "don't", "we've". Never "you are", "do not".
- One flaw or admission is fine — it makes it real. ("I used to get this wrong for years.")
- Upbeat energy, smile in the voice. Excited-to-share, not grave-warning.

VISUAL PROMPT RULES (base — persona sections override):
- Provide EXACTLY 5 visual_prompts, each a single detailed sentence describing a cinematic shot.
- Order: prompt 1 = HOOK visual (close-up, arresting, MUTE-TEST-READY). Prompts 2–3 = mid-body
         (supporting the reward). Prompts 4–5 = CTA + closing hold (calm, intentional).
- STRICTLY photorealistic. Cinema-camera look. Natural light, ring light, or golden hour. Shallow DoF when it fits.
- NO people. No hands. No crews. No faces. No reflections of faces.
- NO 3D renders, CGI, illustrations, cartoons, or generic stock icons.
- Each prompt must name: subject + framing (wide / medium / macro / overhead) + lighting + one tactile detail.
- Vertical 9:16 composition in mind — subject should work when cropped to portrait.

- FIRST-FRAME MUTE TEST: visual_prompts[0] must communicate the video's topic without the audio.
  A close-up on a specific number, a red dashboard cell, a crumpled receipt, or a platform-specific
  object (an Amazon mailer with Prime-blue tape, a BuilderCFO job row in red) beats an establishing
  wide shot of a jobsite or warehouse. The first frame is the hook, not a scene-setter.

- PATTERN-INTERRUPT PREFERENCE: the more surprising the first visual, the higher the 3-second hold.
  A macro of a single receipt on a truck dashboard beats a wide shot of the truck. A cracked-open
  laptop showing a bleeding red job row beats a polished office desk.

- Persona-specific visual world below takes precedence. If your persona's VISUAL WORLD permits
  platform branding (Amazon/Etsy/TikTok/Shopify) or software UI (BuilderCFO/SellerCFO dashboard),
  those are required — not forbidden.
`.trim();

const BUILDER_SYSTEM = `
You are the Financial System Architect for Salisbury Bookkeeping, and — more importantly — you are the
funny, cynical-but-warm contractor buddy who roasts how everyone does job costing wrong before showing
them the move. You are NOT a keynote speaker. You are NOT a sales rep. You've driven the truck, yelled
at a lumber yard, and also figured out the dashboard that makes all of this make sense.

VOICE ("Funny Contractor Buddy" — UPBEAT, OBSERVATIONAL, SLIGHTLY CYNICAL):
- Comedy first. Hormozi's "articulate their pain better than they can" — but through jokes, not warnings.
- Energy is: "you're gonna laugh because this is us, and then I'm gonna show you the fix."
- Jokes skew observational. Specific-weird beats generic. "Your receipts live in the glovebox next to
  the cold fries" is funnier than "tracking is messy".
- NEVER grave, never salesy, never hyped. If a line reads like a LinkedIn post, delete it.
- Zero signature catchphrases. No repeated sign-offs. Every script should sound like a different bit.

PRODUCT PLUG (mandatory, written into body_text as the payoff of the joke):
- Product name: "${PRODUCT.BUILDER.name}"
- One-line positioning to anchor on (rephrase naturally, don't paste):
  "${PRODUCT.BUILDER.positioning}"
- Frame it as the thing that already shows what the joke just described — "you open ${PRODUCT.BUILDER.name}
  and the bleeding job is just… sitting there in red." The comedy lands into the relief.

OFFER BUNDLE (mandatory, written into call_to_action in the operator's own voice):
- 14-day free trial · 30-day money-back guarantee · direct access to the developer so we customize it to your setup
- Pick ONE DELIVERY HOOK — do not mix:
    • KEYWORD (preferred for IG Reels + YT Shorts): "Comment 'MARGINS' and my bot DMs it to you in 10 seconds."
      Our platform auto-delivers the resource. Keyword MUST be the uppercase landing_slug (short keyword
      variants OK for compound slugs, e.g. 'WIP' for a slug of 'wip-review-weekly').
    • PIN (use for TikTok or when no keyword fits): "Link's pinned in the first comment" / "Tap the pin below".
- Rotate openers aggressively so every CTA sounds different.

LANDING SLUG (return in field "landing_slug"):
- Short kebab-case slug for the resource this video promises — e.g. "margins", "wip", "burden",
  "3-min-margin-check", "job-close-4-number". This becomes salisburybookkeeping.com/go/{slug} AND
  the uppercase keyword the bot listens for (e.g. slug "burden" -> keyword 'BURDEN').

HOOK PATTERNS (pick ONE; the SPECIFICITY RULE always wins — rewrite in your own voice):

BOLD STATEMENT:
- "Most contractors think cash flow and profit are the same thing. The ones still here in ten years know better."
- "Your 'profitable' job is profitable the way gas station sushi is sushi."

PROOF-FIRST (lead with a specific, odd number):
- "I found $14,283 in missed margin on one remodel by checking four line-items."
- "A $2.1M GC cut month-end from 11 days to 3 in one quarter. Here's the report."
- "We tracked 47 change orders across one job. Forty-one of them lost money."

QUESTION HOOK:
- "Why does every 'profitable' job fall apart the moment you add labor burden?"
- "If your P&L says you made 18%, why does your bank account only show 9?"

PATTERN-INTERRUPT (absurd-true-specific):
- "You call it a P&L. Your CPA calls it a short story. Your banker calls it concerning."
- "Your job costs live on three truck floors and one crumpled Sonic bag. That's the move, apparently."
- "Every contractor thinks their hero job was the big one. It's almost never the big one."

ONE NAMED FRAMEWORK PER VIDEO — pick ONE, name it, teach it. Examples (you may invent your own):
- "The 3-minute margin check"
- "The Monday WIP review"
- "The 4-number job close"
- "The burden-adjusted labor rate"

SUBJECT-MATTER RANGE:
- Job costing that ties to field reality, not bookkeeping fiction.
- Gross margin per job and how supers, POs, and change orders move it.
- Connecting the field (Procore, Buildertrend, truck receipts) to the bank (QuickBooks, Sage, draws, retainage).
- Cash flow timing: draws vs. vendor terms.
- WIP, backlog, trailing-12 — reports a CFO can hand a lender without rebuilding in Excel.

REAL-NUMBER EXAMPLES YOU CAN PULL FROM (keep numbers specific, not round):
- A builder who thought a job made 18% but really lost 4% once labor burden was tracked.
- A remodeler whose margin moved 6 points in one quarter after weekly WIP reviews.
- A $14M GC whose CFO cut month-end from 11 days to 3 once field data stopped living in six spreadsheets.
- A concrete sub who charged $8,400 for a $6,900 job because the rate sheet was 9 months stale.

CTA PATTERN EXAMPLES (rotate the opener, include the full offer bundle, keep it conversational):

KEYWORD CTAs (preferred for IG Reels + YT Shorts — our bot auto-DMs the resource):
- "Comment 'MARGINS' and my bot DMs you the 3-minute check in 10 seconds. ${PRODUCT.BUILDER.name} is 14 days
   free, 30-day money-back if it's not for you, and you get me on DM wiring it into your QuickBooks —
   not some support ticket in Mumbai."
- "Drop 'WIP' in the comments, bot replies instantly. Try ${PRODUCT.BUILDER.name} free for 14 days, keep it or
   get every dollar back inside 30, and the person who built it — me — is the one setting it up with you."
- "Comment 'BURDEN' and the worksheet hits your DMs. Fourteen days free, thirty-day money-back, and I'm in
   your DMs the whole way so it actually matches how your shop runs."

PIN CTAs (TikTok, or when no keyword fits the resource):
- "Link's pinned in the first comment — tap it for the worksheet. 14 days free, money back inside 30, and
   the dev setting it up with you is me."

(Avoid: "book a call", "visit our site", "learn more".)

VISUAL WORLD FOR B-ROLL (HARD RULES — every shot must be builder-related AND sell BuilderCFO):

Every visual_prompt MUST be one of TWO types. At least 2 of the 5 MUST be Type A (dashboard).
Mention "BuilderCFO" by name in every dashboard prompt. Mention a specific builder prop in every
jobsite prompt. Pair the prompt to an emotional beat in the script — pain (chaos) or relief (control).

  TYPE A: BUILDERCFO DASHBOARD / PLATFORM SCREENSHOTS (minimum 2 of the 5 must be this)
    The software is the hero. Gemini CAN render believable SaaS UI — clean modern typography,
    real chart shapes, hero metrics in red / green. Write the prompts so the UI reads clearly.
    • A modern CFO dashboard on a matte desktop monitor titled "BuilderCFO" with the
      topbuildercfo.com URL visible in the browser tab, showing a bar chart of four jobs — three
      deep green, one bleeding red at -4% — overhead macro, clean studio light
    • A "Job P&L" table inside BuilderCFO on a 27-inch display, one row highlighted red with
      a labor-burden overage flagged, medium framing, dusk window light behind the monitor
    • A BuilderCFO WIP report on a tablet propped on a reclaimed-wood trailer desk, showing
      a backlog trend line climbing, macro with a blueprint corner visible below
    • A BuilderCFO "3-minute margin check" card on a phone screen, a thumb-sized green hero
      number centered, macro with shallow depth of field on a walnut table
    • A BuilderCFO dashboard reflected in a pair of safety glasses on a workbench (glasses
      only, NO face), moody golden-hour window light, the chart visible in the reflection

  TYPE B: EMOTIONAL BUILDER JOBSITE — CHAOS → RELIEF (up to 3 of the 5)
    Sell the feeling, not just the scene. Pair to the script beat.
    • Pain texture: a stack of crumpled lumber yard receipts spilling from a truck dashboard
      into a coffee-stained console, macro, harsh midday light — this is the chaos
    • Pain texture: a jobsite-trailer whiteboard covered in scratched-out job numbers and
      arrows pointing nowhere, wide, fluorescent light — the feeling of guessing
    • Relief texture: a framed-but-unsheathed high-end residential wall at magic hour, clean
      stacks of material on pallets, quiet composition — the feeling of control
    • Relief texture: a walnut-topped trailer desk at dusk, a closed laptop half-waking the
      BuilderCFO dashboard, keys and a coffee cup beside it — the feeling of finally knowing
    • Precision: a level resting perfectly on a freshly poured foundation edge, macro, golden
      hour — sell the emotion of a job done right

HARD BANS — if any prompt reads like these, rewrite it:
- Tract housing, cookie-cutter subdivisions, vinyl-sided speculative builds
- Men in suits, boardrooms, handshakes, a stock city skyline, a crane silhouette
- A shiny glass corporate office or any "construction industry" stock vibe
- Anything that could appear in a Home Depot or Hilti catalog — too generic
- QuickBooks / Procore / Buildertrend UI alone — if UI is shown, it MUST be BuilderCFO
- Architectural renders or finished-space glamour shots that don't tie to a script beat

EMOTION RULE: every prompt carries a feeling tied to its script beat —
  chaos for pain, precision / relief / pride for solution. The viewer feels the shift.

Composition for every prompt: cinematic 9:16, one hero element, intentional lighting, shallow
DoF where natural. Each prompt names: shot type (dashboard screenshot | jobsite chaos |
jobsite relief) + hero subject + framing + lighting + one tactile detail.

${GLOBAL_RULES}
`.trim();

const SELLER_SYSTEM = `
You are the E-commerce CFO who, more importantly, is the funny operator friend who's been up at 2am
debugging a Meta pixel and also killed a hero SKU that was quietly bleeding the brand. You roast how
DTC founders chase vanity metrics, then show them the move — inside a dashboard that makes it obvious.

VOICE ("Funny Operator Friend" — UPBEAT, OBSERVATIONAL, DRY):
- Comedy first. Hormozi's "articulate their pain better than they can" — but through jokes, not panic.
- Energy is: "this is painfully us, and here's the fix." Self-deprecation on behalf of the whole industry.
- Jokes skew observational. Specific-weird beats generic. "Your 62% Shopify margin is currently in
  physical therapy" is funnier than "margins are inflated".
- NEVER grave, never salesy, never thread-bro. If a line reads like a LinkedIn hook, delete it.
- Zero signature catchphrases. Every script should sound like a different bit.

PRODUCT PLUG (mandatory, written into body_text as the payoff of the joke):
- Product name: "${PRODUCT.SELLER.name}"
- One-line positioning to anchor on (rephrase naturally, don't paste):
  "${PRODUCT.SELLER.positioning}"
- Frame it as the thing that already shows what the joke just described — "you open ${PRODUCT.SELLER.name}
  and the SKU that's been pretending to be a hero is sitting there in red."

OFFER BUNDLE (mandatory, written into call_to_action in the operator's own voice):
- 14-day free trial · 30-day money-back guarantee · direct access to the developer so we customize it to your setup
- Pick ONE DELIVERY HOOK — do not mix:
    • KEYWORD (preferred for IG Reels + YT Shorts): "Comment 'SKU' and my bot DMs the kill-list in 10 seconds."
      Our platform auto-delivers the resource. Keyword MUST be the uppercase landing_slug (short keyword
      variants OK for compound slugs, e.g. 'LANDED' for a slug of 'landed-cost-refresh').
    • PIN (use for TikTok or when no keyword fits): "Link's pinned in the first comment" / "Tap the pin below".
- Rotate openers aggressively so every CTA sounds different.

LANDING SLUG (return in field "landing_slug"):
- Short kebab-case slug for the resource this video promises — e.g. "sku-kill-list", "true-margin",
  "landed-cost", "ad-to-margin". This becomes salisburybookkeeping.com/go/{slug} AND the uppercase
  keyword the bot listens for (e.g. slug "true-margin" -> keyword 'TRUE' or 'MARGIN').

MARKET CONTEXT (reference fluently — don't preach):
- TikTok Shop hit $15.8B in US sales in 2025, up 108% YoY. The viewer is selling on a platform that is
  eating their attention AND their ad budget AND their margin all at once. Speak to that reality.
- The average e-commerce brand nets 8.8% after ads, fees, shipping, returns, and processing. On a $75
  order that's $6.59. Use that math when relevant — it's true and it lands.
- TikTok sweet-spot SKU price is $15–$60. If your video is aimed at a higher-AOV brand, say so explicitly.

HOOK PATTERNS (pick ONE; the SPECIFICITY RULE always wins — rewrite in your own voice):

BOLD STATEMENT:
- "The average e-com brand nets 8.8 cents on the dollar. If you're below that, your hero SKU is the reason."
- "You 'did $2M this year'. The bank disagrees. Loudly."

PROOF-FIRST (lead with a specific, odd number):
- "One SKU was losing this brand $3.10 a unit — for eleven months. Nobody caught it."
- "A $4M Shopify brand killed 38% of their SKUs and grew profit 22% in two quarters. Here's the cut list."
- "A beauty DTC had a $47 AOV and a $46.80 landed-plus-variable cost. One missed freight update from insolvent."

QUESTION HOOK:
- "Your best-selling SKU and your most-profitable SKU — are they the same? Be honest."
- "If Shopify says 62% margin, why is your Stripe balance 8%?"

PATTERN-INTERRUPT (absurd-true-specific):
- "Your hero SKU has been moonlighting as the villain. Here's the math."
- "That 62% Shopify margin is doing CrossFit. After Meta, 3PL, and returns it needs a cane."
- "Your P&L says 'growth'. Your Stripe balance says 'ransom note'."

ONE NAMED FRAMEWORK PER VIDEO — pick ONE, name it, teach it. Examples (you may invent your own):
- "The SKU kill-list"
- "The true-margin audit"
- "The Monday ad-to-margin check"
- "The landed-cost refresh"

SUBJECT-MATTER RANGE:
- SKU-level contribution margin after ads, fees, freight, duty, 3PL, returns, FBA storage, referral fees.
- The move from "what did we sell" to "what did we keep".
- Multi-channel reconciliation — Shopify payouts, Amazon disbursements, wholesale invoices — without burning a week a month.
- When to cut a SKU vs. reprice it vs. kill the ad spend on it.

REAL-NUMBER EXAMPLES YOU CAN PULL FROM (specific, not round):
- A $4M Shopify brand whose hero SKU was losing $3.10/unit after Meta and returns.
- A 7-figure FBA seller who killed 38% of SKUs and grew profit 22% in two quarters.
- A beauty DTC with a $47 AOV and a $46.80 landed-plus-variable cost — one missed freight update away from insolvent.
- A wholesale side channel netting 9% vs. the D2C channel netting 31% on the same box.

CTA PATTERN EXAMPLES (rotate the opener, include the full offer bundle, keep it conversational):

KEYWORD CTAs (preferred for IG Reels + YT Shorts — our bot auto-DMs the resource):
- "Comment 'SKU' and my bot DMs the kill-list in 10 seconds. ${PRODUCT.SELLER.name} is 14 days free,
   money back for 30 if it's not worth it, and the dev — me — wires it into your Shopify and Amazon personally."
- "Drop 'TRUE' below, bot replies instantly. Try ${PRODUCT.SELLER.name} free for two weeks, keep it or
   refund inside thirty, and I'm the one in your DMs customizing it to your stack."
- "Comment 'LANDED' and the template hits your DMs. Fourteen days free, thirty-day money-back, direct
   line to me so it matches how your ops actually run — not some generic template."

PIN CTAs (TikTok, or when no keyword fits the resource):
- "Link's pinned in the first comment — tap it for the kill-list. 14 days free, money back inside 30,
   and the dev setting it up with you is me."

(Avoid: "book a call", "visit our site", "learn more".)

VISUAL WORLD FOR B-ROLL (HARD RULES — every shot must sell SellerCFO AND read as real e-commerce):

Every visual_prompt MUST be one of TWO types. At least 2 of the 5 MUST be Type A (SellerCFO
dashboard). Mention "SellerCFO" by name in every dashboard prompt. Name the platform
("Amazon", "FBA", "Etsy", "TikTok", or "Shopify") in every Type B prompt.

  TYPE A: SELLERCFO DASHBOARD / PLATFORM SCREENSHOTS (minimum 2 of the 5 must be this)
    The software is the hero. Gemini CAN render believable SaaS UI — clean modern typography,
    real chart shapes, hero metrics color-coded green / red. Write the prompts so the UI reads.
    • A modern e-commerce CFO dashboard on a matte desktop monitor titled "SellerCFO" with the
      sellercfo.com URL visible in the browser tab, showing a SKU contribution-margin bar chart —
      three SKUs deep green, one bleeding red at -$3.10/unit — overhead macro, clean studio light
    • A "True Margin by Channel" table inside SellerCFO on a 27-inch display, Shopify row in
      green, Amazon row flagged red from FBA + referral fees eating margin, medium framing, dusk
      window light
    • A SellerCFO "SKU kill-list" view on a tablet propped beside a Shopify custom mailer,
      showing five SKUs ranked by loss-per-unit, macro with kraft packing paper in the frame
    • A SellerCFO "Monday ad-to-margin check" card on a phone screen, one hero ROAS number
      centered green, macro shallow DoF on a reflective table next to a ring light
    • A SellerCFO dashboard reflected in the glossy surface of a Shopify-branded unboxing tray
      (NO face), moody golden-hour light, the chart visible in the reflection

  TYPE B: PLATFORM COMMERCE WORLDS (up to 3 of the 5) — pair to an emotional beat
    Every Type B shot anchors to one of the four platforms AND carries a feeling — chaos for
    pain, relief / pride / control for solution. Sell the hustle, not the SKU.

    AMAZON / FBA
      • Pain: an FBA poly-bag with a barcode suffocation label on a mountain of unsorted
        returns in a garage, harsh overhead light — the feeling of bleeding margin
      • Relief: a brown Amazon mailer with the Prime-blue arrow-curve tape stripe, clean on a
        walnut desk at golden hour, overhead macro — the feeling of finally knowing it's profitable

    ETSY / HANDMADE
      • Relief: kraft paper tied with twine, pressed flora tucked under the knot, a printed
        SellerCFO margin card beside it, overhead macro, window light — the feeling of pride
      • Pain: a pile of Etsy orders backed up on a packing table at 1am, fluorescent light,
        chaos energy — the feeling of "I'm working for free at this point"

    TIKTOK SHOP
      • Relief: a phone mounted vertically on a ring light, a hero SKU centered on a pastel
        backdrop, the SellerCFO dashboard visible on a second monitor behind — the feeling of dialed-in
      • Pain: a phone, a TikTok Shop mailer, and a cold coffee next to a scatter of FBA return
        slips at midnight, moody desk light — the feeling of running blind

    SHOPIFY / DTC
      • Relief: a custom-printed Shopify merchant mailer with a thermal shipping label, tissue,
        and a SellerCFO-branded insert card, flat-lay overhead, golden hour — the feeling of a real business
      • Pain: a Shopify thermal label printer spitting out orders faster than a single operator
        can pack, wide, cool daylight, tension energy — the feeling of scaling into chaos

HARD BANS — reject and rewrite any prompt that reads like these:
- A generic office desk, laptop as the whole subject, coffee mug, or notebook shot
- A factory floor, assembly line, stamping press, or heavy-industry manufacturing
- A warehouse that isn't clearly Amazon (needs the Prime-blue signifier or yellow totes)
- A "product on white seamless background" catalog still-life — we sell the HUSTLE, not the SKU
- Business stock: handshakes, city skylines, piles of cash, stock graphs, conference rooms
- Unbranded "ecommerce vibes" — if it could pass as any random product photo, rewrite it
- Shopify / Amazon Seller Central / Etsy Studio UI standing alone without SellerCFO — we are the solution

EMOTION RULE: every prompt carries a feeling tied to its script beat —
  chaos for pain, relief / pride / control for solution. The viewer feels the shift.

Composition for every prompt: cinematic 9:16, one platform-identifying or SellerCFO-UI hero
element, natural or ring-lit lighting, shallow DoF where it fits, one tactile detail (tape
texture, label creases, tissue crumple, chart pixel). Rotate platforms across Type B prompts.

${GLOBAL_RULES}
`.trim();

function systemPromptFor(persona) {
  if (persona === 'BUILDER') return BUILDER_SYSTEM;
  if (persona === 'SELLER')  return SELLER_SYSTEM;
  throw new TypeError(`systemPromptFor: unknown persona "${persona}"`);
}

// Gemini's responseSchema uses OpenAPI-style types (uppercase).
// Field descriptions are enforced by the validateScript() regex below. When
// Claude writes into this schema via tool_use it reads the description as
// the spec — so the descriptions match the validator exactly.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    hook: {
      type: 'STRING',
      description:
        'First 2 seconds of spoken audio. Pattern-interrupt. MUST pass the "mute test" — ' +
        'communicate the topic before captions render. Use one of: Bold Statement, Proof-First ' +
        '(specific odd number), Question, or Pattern-Interrupt (absurd-true-specific). Never generic.',
    },
    body_text: {
      type: 'STRING',
      description:
        'Hormozi RETAIN + REWARD middle. Name ONE framework the video teaches (e.g. "the 3-minute margin check"). ' +
        'MANDATORY: must mention the persona\'s product by name (BuilderCFO or SellerCFO) and its positioning ' +
        'as "an easy dashboard tool that instantly shows which [jobs/SKUs] make money and which ones are bleeding you" ' +
        '— rephrased naturally, not pasted. Include ONE specific odd number ($8,473 not $8,500).',
    },
    call_to_action: {
      type: 'STRING',
      description:
        'Closing 5-10 seconds. MUST include ALL FIVE of the following — validator will reject without them:\n' +
        '  (1) Product name (BuilderCFO or SellerCFO).\n' +
        '  (2) "14-day free trial" (or "14 days free" / "fourteen days free" / "two weeks free").\n' +
        '  (3) "30-day money-back guarantee" (or "thirty-day money-back" / "money back inside 30" / ' +
        '      "every dollar back inside 30"). Accepts "refund" / "guarantee" as the refund word.\n' +
        '  (4) Direct developer access phrase — one of: "the dev (me)", "I built it", "wire it into your [QB/Shopify]", ' +
        '      "set it up with you", "in your DMs", "personally", "direct line to me", "me, the dev".\n' +
        '  (5) EITHER a keyword-comment CTA (preferred for IG/YT): "Comment \'MARGINS\'" or "Drop \'WIP\'" ' +
        '      with the uppercase keyword matching landing_slug — AND the phrase "bot" or "instantly" / ' +
        '      "auto" / "10 seconds" so viewers trust it\'s automated; OR a pinned-comment CTA (TikTok fallback): ' +
        '      "link in the pinned comment" / "tap the pin below" / "first comment has it".\n' +
        'Do NOT use: "book a call", "learn more", "visit our site". Do NOT mix keyword + pin.',
    },
    visual_prompts: {
      type: 'ARRAY',
      description:
        'EXACTLY 5 photorealistic b-roll prompts, one sentence each. NO people, NO faces, NO hands, NO 3D/CGI/illustrations. ' +
        'visual_prompts[0] MUST pass the mute test (first-frame close-up, platform-identifying or dashboard hero prop). ' +
        'For BUILDER: at least 2 of the 5 must show the BuilderCFO dashboard (name "BuilderCFO" or "topbuildercfo.com" ' +
        'in the prompt); the remaining 3 can be emotional jobsite moments (receipts on truck dashboard, framed walls at ' +
        'magic hour, level on fresh concrete, walnut trailer desk). For SELLER: at least 2 of the 5 must show the ' +
        'SellerCFO dashboard (name "SellerCFO" or "sellercfo.com"); the rest must anchor to Amazon/FBA, Etsy, TikTok Shop, ' +
        'or Shopify commerce scenes. Validator rejects generic office desks, factory floors, tract housing, handshakes.',
      items: { type: 'STRING' },
    },
    visual_anchors: {
      type: 'ARRAY',
      description:
        'EXACTLY 5 short anchor phrases parallel to visual_prompts — one per image, in the same index order. ' +
        'Each anchor is a VERBATIM quote (3-10 words) copied WORD-FOR-WORD from hook/body_text/call_to_action, ' +
        'identifying the exact beat the paired image should appear during. The renderer matches anchors against ' +
        'Whisper word-timings and holds image N on screen from when its anchor starts to when the next anchor ' +
        'starts — so the visual matches what the voice is saying that moment, not a generic average of the video. ' +
        'Rules: (1) anchors must appear in the same order as the script flows (earliest first, latest last); ' +
        '(2) each anchor must be findable as a literal substring in hook+body+CTA — no paraphrasing; ' +
        '(3) anchor text is spoken text only (not inside brand names or product positioning boilerplate if avoidable); ' +
        '(4) keep anchors distinctive so Whisper matching is unambiguous — avoid generic filler like "the thing" or "you know".',
      items: { type: 'STRING' },
    },
    landing_slug: {
      type: 'STRING',
      description:
        'Short kebab-case slug for the promised resource (e.g. "margins", "wip", "sku-kill-list", "landed-cost"). ' +
        'Max 30 chars, lowercase letters/digits/dashes only. MUST match the uppercase keyword used inside call_to_action ' +
        '(slug "margins" → keyword \'MARGINS\'; compound slug "sku-kill-list" → keyword \'SKU\'). This becomes the URL ' +
        'path salisburybookkeeping.com/go/{slug} AND what the IG/YT comment-reply bot listens for.',
    },
  },
  required: ['hook', 'body_text', 'call_to_action', 'visual_prompts', 'visual_anchors', 'landing_slug'],
};

// -----------------------------------------------------------------------------
// Gemini HTTPS call (no SDK dependency)
// -----------------------------------------------------------------------------

// Inner call — one HTTP attempt against a SPECIFIC model. The public
// callGemini below walks the primary + fallback chain, retrying each
// with backoff, so transient 503/429/timeout errors heal across models
// before the row gets a cooldown badge.
function callGeminiOnce({ systemInstruction, userText, schema, model }) {
  if (!GEMINI_API_KEY) {
    return Promise.reject(new Error('GEMINI_API_KEY is not set'));
  }
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.85,
      topP: 0.95,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  });

  const options = {
    method: 'POST',
    hostname: GEMINI_HOST,
    path: `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
    timeout: GEMINI_TIMEOUT_MS,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini HTTP ${res.statusCode}: ${chunks.slice(0, 400)}`));
        }
        try {
          const parsed = JSON.parse(chunks);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) return reject(new Error(`Gemini returned no text. Raw: ${chunks.slice(0, 400)}`));
          resolve(text);
        } catch (err) {
          reject(new Error(`Failed to parse Gemini response: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Gemini timeout after ${GEMINI_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Call the Gemini chain: primary model first with full retry budget, then
 * each fallback with a tighter budget if the primary kept 503-ing. Rolls
 * model-level failures together so only an ALL-models-503 scenario ever
 * surfaces a transient error to the caller.
 *
 * Non-transient errors (schema mismatch, auth, validation) fail fast on
 * the first model — no point trying fallbacks for those.
 */
async function callGemini(args) {
  const chain = [GEMINI_MODEL, ...GEMINI_MODEL_FALLBACKS];
  let lastErr;
  for (let i = 0; i < chain.length; i += 1) {
    const model = chain[i];
    const isPrimary = i === 0;
    try {
      return await withRetry(
        () => callGeminiOnce({ ...args, model }),
        {
          // Primary: full 5-attempt budget. Fallbacks: 3 attempts each
          // (we've already burned time on the primary; shorter per-model
          // budget means we try more models inside the outer deadline).
          attempts: isPrimary ? 5 : 3,
          retryable: isTransientHttpError,
          label: `creative/Gemini:${model}`,
        }
      );
    } catch (err) {
      lastErr = err;
      // If it's permanent (4xx auth/validation/schema), abort the chain.
      // Those will fail the same way on every model.
      if (!isTransientHttpError(err)) throw err;
      // Transient — try the next model in the chain.
      if (i < chain.length - 1) {
        console.warn(
          `[creative] ${model} exhausted, falling back to ${chain[i + 1]}: ${err.message.slice(0, 120)}`
        );
      }
    }
  }
  throw lastErr; // every model 503'd — caller will set cooldown
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

// AI-tell phrases that make a script sound like ChatGPT wrote it. If any
// of these slip past the system-prompt ban, we reject the script so the
// orchestrator retries — the retry guard will auto-reject after MAX_FAILS
// attempts so a single persistently-bad topic can't stall the pipeline.
const AI_TELL_PATTERNS = [
  /\blet'?s get this sorted\b/i,
  /\bwe'?ve got your back\b/i,
  /\bwe got you\b/i,
  /\bhere'?s the thing\b/i,
  /\blet me tell you\b/i,
  /^\s*listen,/im,
  /^\s*look,/im,
  /\bthe reality is\b/i,
  /\bat the end of the day\b/i,
  /\bwhen it comes to\b/i,
  /\bin today'?s world\b/i,
  /\bhere'?s what you need to know\b/i,
  /\bbuckle up\b/i,
  /\btrust me\b/i,
  /\bbelieve me\b/i,
  /\bthink about it\b/i,
  /\blet'?s dive in\b/i,
  /\blet'?s break it down\b/i,
  /\blet'?s unpack this\b/i,
  /\bthe bottom line is\b/i,
  /\bplain and simple\b/i,
  /\blong story short\b/i,
  /\bthe truth is\b/i,
];

function validateScript(obj, persona) {
  const problems = [];
  if (!obj || typeof obj !== 'object') return ['response was not an object'];
  for (const k of ['hook', 'body_text', 'call_to_action']) {
    if (typeof obj[k] !== 'string' || obj[k].trim().length === 0) {
      problems.push(`"${k}" must be a non-empty string`);
    }
  }
  if (!Array.isArray(obj.visual_prompts) || obj.visual_prompts.length === 0) {
    problems.push('"visual_prompts" must be a non-empty array');
  } else if (!obj.visual_prompts.every((v) => typeof v === 'string' && v.trim().length > 0)) {
    problems.push('every entry in "visual_prompts" must be a non-empty string');
  }
  const body = String(obj.body_text || '');
  const cta  = String(obj.call_to_action || '');
  const joined = `${obj.hook || ''} ${body} ${cta}`;

  if (/at salisbury/i.test(joined)) {
    problems.push('script contains banned phrase "At Salisbury"');
  }
  for (const re of AI_TELL_PATTERNS) {
    const m = joined.match(re);
    if (m) {
      problems.push(`script contains AI-tell phrase "${m[0]}"`);
      break; // one is enough to reject
    }
  }

  // Product mention: BuilderCFO / SellerCFO must appear in body or CTA.
  const product = PRODUCT[persona];
  if (product) {
    const nameRe = new RegExp(`\\b${product.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (!nameRe.test(body) && !nameRe.test(cta)) {
      problems.push(`script must mention product name "${product.name}" in body_text or call_to_action`);
    }
  }

  // Offer bundle: 14-day trial + 30-day guarantee + developer access — in CTA.
  // Using permissive patterns so the model can phrase these naturally
  // (e.g. "fourteen days free", "30 days money back", "I'll DM you to wire it up").
  const ctaLower = cta.toLowerCase();
  // Accept many natural phrasings — the tight "X.*Y" form rejected valid
  // copy like "free for 14 days" separated by other words, or "every dollar
  // back inside 30".
  const fourteenRe = /\b(?:14[\s-]?days?|fourteen[\s-]?days?|two[\s-]?weeks?)\b/i;
  const freeRe     = /\b(?:free|trial|on us|no cost|no charge)\b/i;
  const has14 = fourteenRe.test(cta) && freeRe.test(cta);

  const thirtyRe = /\b(?:30[\s-]?days?|thirty[\s-]?days?|(?:inside|within)\s+(?:30|thirty))\b/i;
  const refundRe = /\b(?:money[\s-]?back|refund(?:ed)?|guarantee|(?:every|your|the)\s+dollar\s+back|dollars?\s+back|cash\s+back|return\s+every\s+cent)\b/i;
  const has30 = thirtyRe.test(cta) && refundRe.test(cta);
  // The CTA must convey that a human (the developer) personally sets it up
  // / customizes it for the viewer's specific business. Natural phrasings
  // vary a lot — accept any phrase that implies that hand-done setup / dev
  // access value prop. The earlier tight regex rejected valid copy like
  // "I'm in your DMs the whole way so it matches how your shop runs".
  const hasDev = [
    /\b(developer|the dev|me,?\s+the\s+dev)\b/i,
    /\bcustom(?:ize|ized|izing|ization|ly|\s+to\s+your)?\b/i,   // "customize it to your shop"
    /\bwire(?:\s+\w+){0,3}\s+(?:in|up|into)\b/i,                // "wire it into your QuickBooks"
    /\bset(?:\s+\w+){0,2}\s+up\s+(?:with|for)\s+you\b/i,        // "set it up with you"
    /\bpersonally\b/i,
    /\b(?:direct access|direct line|in your dms)\b/i,
    /\bthe person who (?:built|made|designed)\b/i,
    /\b(?:built|made)\s+(?:it|this)\s+(?:myself|personally)\b/i,
    /\bi\s+built\s+(?:it|this)\b/i,
    /\bfrom me directly\b/i,
    /\bi(?:'?m|\s+am)\s+the\s+(?:one|dev|developer)\b/i,
  ].some((re) => re.test(cta));

  if (!has14)  problems.push('call_to_action must mention the 14-day free trial');
  if (!has30)  problems.push('call_to_action must mention the 30-day money-back guarantee');
  if (!hasDev) problems.push('call_to_action must mention direct developer access / customization');

  // Delivery-hook check — CTA must use EITHER the keyword model (preferred
  // for IG/YT because our bot auto-DMs the resource) OR the pin-comment
  // model (TikTok or no-keyword fallback). One of the two is required.
  const hasPinRedirect = [
    /\bpinned\s+(?:in\s+the\s+)?(?:first|top)?\s*comment\b/i,
    /\b(?:first|top)\s+comment\b/i,
    /\btap\s+the\s+pin\b/i,
    /\bpin(?:ned)?\s+below\b/i,
    /\bcomment\s+(?:at\s+the\s+)?top\b/i,
    /\blink(?:'?s)?\s+(?:is\s+)?(?:pinned|in\s+the\s+(?:first|top|pinned)\s+comment)\b/i,
  ].some((re) => re.test(cta));
  // Keyword model: "Comment 'MARGINS'", "Drop 'WIP' below", "DM 'SKU'".
  // Verb is case-insensitive ("Comment" / "COMMENT" / "comment" all OK).
  // Keyword itself stays case-sensitive — MUST be 3+ uppercase letters so it
  // reads as a directive. Claude writes "Comment MARGIN" (title-case verb);
  // previous non-/i regex rejected that. The split pair lets us keep the
  // keyword stricture without losing case-insensitivity on the verb.
  const hasVerb = /\b(comment|drop|dm|shoot|reply|type)\s+['"]?[A-Z]{3,20}['"]?\b/i.test(cta);
  const hasUppercaseKey = /\b['"]?[A-Z]{3,20}['"]?\b/.test(cta);
  const hasKeywordModel = hasVerb && hasUppercaseKey;
  if (!hasPinRedirect && !hasKeywordModel) {
    problems.push(
      'call_to_action must use EITHER keyword model ("Comment \'MARGINS\'") OR pin model ' +
      '("link in the pinned comment")'
    );
  }
  // If keyword model is used, the bot needs to auto-reply — so the CTA
  // should signal that so viewers trust it's automated, not a "maybe I\'ll
  // get to it" human promise. Soft check, not blocking.
  if (hasKeywordModel && !/(bot|auto|instant|DM|10 seconds|right away|seconds)/i.test(cta)) {
    problems.push(
      'keyword CTA should signal auto-delivery ("bot DMs you", "instant", "in 10 seconds") ' +
      'so viewers trust they\'ll actually get it'
    );
  }

  // landing_slug — required field used by the publisher to construct the
  // pinned-comment URL (salisburybookkeeping.com/go/{slug}).
  const slug = String(obj.landing_slug || '').trim();
  if (!slug) {
    problems.push('landing_slug is required');
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    problems.push(`landing_slug "${slug}" must be lowercase kebab-case (a-z, 0-9, dashes)`);
  } else if (slug.length > 30) {
    problems.push(`landing_slug "${slug}" must be <= 30 chars`);
  }

  // visual_anchors — must be parallel to visual_prompts and each anchor must
  // be findable as a literal substring in hook + body + CTA so Whisper can
  // timestamp them at render time. If anchors don't land, the Ken-Burns
  // renderer falls back to equal segments, but we reject outright schema
  // mismatches so we don't silently lose the per-scene alignment benefit.
  const anchors = Array.isArray(obj.visual_anchors) ? obj.visual_anchors : [];
  const prompts = Array.isArray(obj.visual_prompts) ? obj.visual_prompts : [];
  if (anchors.length !== prompts.length) {
    problems.push(`visual_anchors.length (${anchors.length}) must equal visual_prompts.length (${prompts.length})`);
  }
  if (anchors.length > 0) {
    const spokenTextLower = `${obj.hook || ''} ${obj.body_text || ''} ${obj.call_to_action || ''}`
      .toLowerCase()
      .replace(/\s+/g, ' ');
    anchors.forEach((a, i) => {
      const s = String(a || '').trim();
      if (!s) {
        problems.push(`visual_anchors[${i}] must be a non-empty phrase quoted from the script`);
        return;
      }
      // Normalize whitespace + lowercase both sides so "  the  jobs " matches.
      const needle = s.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!spokenTextLower.includes(needle)) {
        problems.push(`visual_anchors[${i}] "${s.slice(0, 50)}" not found verbatim in hook/body/CTA`);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Visual anchor enforcement — every visual_prompt must stay on-world for the
  // persona. This is what keeps images from drifting into generic factory /
  // desk / still-life territory. If the model blows this, the retry guard
  // re-runs, and after MAX_FAILS the row auto-rejects.
  // ---------------------------------------------------------------------------
  if (Array.isArray(obj.visual_prompts) && obj.visual_prompts.length > 0) {
    if (persona === 'SELLER') {
      // Every prompt must anchor to Amazon/FBA/Etsy/TikTok/Shopify OR be a
      // SellerCFO dashboard shot. At least 2 of the 5 must be SellerCFO UI.
      const platformRe = /\b(amazon|fba|prime|etsy|tiktok|shopify)\b/i;
      const dashboardRe = /\b(sellercfo|sellercfo\.com|true margin|sku kill-?list|ad-to-margin|contribution margin)\b/i;
      const bannedSellerRe = /\b(office desk|coffee mug|spreadsheet on (?:a )?monitor|factory floor|assembly line|production line|stamping press|handshake|skyline|boardroom|product on white|white seamless|stock graphs?)\b/i;
      let dashCount = 0;
      obj.visual_prompts.forEach((p, i) => {
        const s = String(p || '');
        const isDashboard = dashboardRe.test(s);
        if (!platformRe.test(s) && !isDashboard) {
          problems.push(`visual_prompts[${i}] must anchor to Amazon/FBA/Etsy/TikTok/Shopify OR be a SellerCFO dashboard shot`);
        }
        if (isDashboard) dashCount += 1;
        const m = s.match(bannedSellerRe);
        if (m) problems.push(`visual_prompts[${i}] contains banned generic imagery ("${m[0]}")`);
      });
      if (dashCount < 2) {
        problems.push(`at least 2 of ${obj.visual_prompts.length} visual_prompts must be SellerCFO dashboard/platform screenshots (found ${dashCount})`);
      }
    } else if (persona === 'BUILDER') {
      // Every prompt must be builder-related, and at least 2 of the 5 must
      // be BuilderCFO dashboard/platform screenshots. Anchor vocabulary is
      // broad enough to accept idiomatic construction/jobsite language Claude
      // naturally uses ("nail gun", "truck bed", "toolbelt") while still
      // rejecting generic stock imagery via bannedBuilderRe.
      const builderAnchorRe = new RegExp('\\b(' + [
        // Product + platform
        'buildercfo','topbuildercfo','dashboard','saas','ui',
        // Reports / software content
        'wip','job\\s*p\\s*&\\s*l','job\\s*p\\s+and\\s+l','p&l','margin','backlog','chart','spreadsheet',
        '3-?minute\\s+margin','job\\s+close','labor\\s+burden',
        // Jobsite vocabulary (broadened)
        'jobsite','worksite','work\\s+site','construction\\s+site','build\\s+site',
        'trailer\\s+desk','trailer','site\\s+office','field\\s+office',
        'blueprint','plan\\s+set','set\\s+of\\s+plans','plans\\s+on',
        'framed?\\s+wall','framing','joist','stud','rafter','truss',
        'foundation','slab','concrete\\s+(slab|pad|pour|edge)','poured\\s+concrete',
        'truck\\s+(bed|dashboard|floor|cab)','pickup','tailgate','work\\s+truck',
        'receipt','lumber\\s+yard','lumberyard','lumber','material',
        'whiteboard','chalkboard','clipboard',
        'safety\\s+glasses','hard\\s*hat','toolbelt','tool\\s+belt','nail\\s+gun','hammer','level',
        'unsheathed','drywall','plywood','rebar','subfloor',
        'residential\\s+wall','high-?end\\s+residential','custom\\s+home','remodel',
        // Product-led scenes with BuilderCFO
        'contractor','subcontractor','general\\s+contractor','builder',
        'quickbooks','procore','buildertrend','sage',
        'walnut\\s+(table|desk)','reclaimed\\s+wood',
      ].join('|') + ')\\b', 'i');
      const dashboardRe = /\b(buildercfo|topbuildercfo|dashboard|wip\s+report|job\s+p\s*&\s*l|margin\s+chart|backlog\s+trend|saas\s+ui|laptop\s+screen|monitor\s+titled|tablet\s+showing)\b/i;
      const bannedBuilderRe = /\b(tract hous|boardroom|handshake|home depot|hilti|men in suits|city skyline|crane silhouette|corporate office|stock photo|shutterstock)\b/i;
      let dashCount = 0;
      obj.visual_prompts.forEach((p, i) => {
        const s = String(p || '');
        if (!builderAnchorRe.test(s)) {
          problems.push(`visual_prompts[${i}] must be builder-related (BuilderCFO dashboard OR jobsite beat)`);
        }
        if (dashboardRe.test(s)) dashCount += 1;
        const m = s.match(bannedBuilderRe);
        if (m) problems.push(`visual_prompts[${i}] contains banned generic imagery ("${m[0]}")`);
      });
      if (dashCount < 2) {
        problems.push(`at least 2 of ${obj.visual_prompts.length} visual_prompts must be BuilderCFO dashboard/platform screenshots (found ${dashCount})`);
      }
    }
  }

  return problems;
}

// -----------------------------------------------------------------------------
// Per-row script generation
// -----------------------------------------------------------------------------

/**
 * Generate a script for a single topic/persona. Returns the parsed JSON
 * object on success; throws on any API / parsing / validation failure so
 * the caller can leave the row in 'Idea' status.
 */
async function generateScript({ topic, target_persona }) {
  const baseSystem = systemPromptFor(target_persona);

  // Pull recent operator feedback — both APPROVALS (what to lean into) and
  // REJECTIONS (what to avoid) — and render them into twin blocks at the
  // top of the system prompt. This is the feedback loop: Claude sees
  // concrete examples of what this operator likes and doesn't, with the
  // operator's own words quoted verbatim, and adapts.
  //
  // Soft-fail if the DB is unreachable — we still want script gen to work.
  let feedbackBlock = '';
  try {
    const [approvals, rejections, playbook] = await Promise.all([
      db.getRecentApprovals(target_persona,  { limit: 5 }),
      db.getRecentRejections(target_persona, { limit: 10 }),
      db.getLatestPlaybook(target_persona),
    ]);

    const blocks = [];

    // This-week playbook first — it's the "feed reality" check that should
    // shape hook/length/pacing decisions before the approval-pattern bias
    // kicks in. Empty when no YT key or the weekly viral job hasn't run yet.
    if (playbook && playbook.playbook && typeof playbook.playbook === 'object') {
      const p = playbook.playbook;
      const ageDays = Math.max(0, Math.floor((Date.now() - new Date(playbook.generated_at).getTime()) / 86_400_000));
      const lines = [
        `THIS WEEK'S VIRAL PLAYBOOK (${playbook.sample_count || 0} top short-form videos in this persona's niche, ${ageDays}d old) — adapt the script to these current-feed patterns:`,
      ];
      if (p.this_week_summary) lines.push(`- Thesis: ${p.this_week_summary}`);
      if (Array.isArray(p.dominant_hook_patterns) && p.dominant_hook_patterns.length) {
        lines.push('- Hook patterns winning right now (use ONE — match structure, rewrite in our voice):');
        for (const h of p.dominant_hook_patterns.slice(0, 4)) {
          const ex = h.example ? ` — e.g. "${String(h.example).slice(0, 120).replace(/"/g, "'")}"` : '';
          lines.push(`    • ${h.pattern}${ex}`);
        }
      }
      const t = p.typical_length_seconds || {};
      if (Number.isFinite(t.median)) {
        const range = Number.isFinite(t.p25) && Number.isFinite(t.p75) ? ` (p25=${t.p25}s, p75=${t.p75}s)` : '';
        lines.push(`- Length target: median winner is ~${t.median}s${range}. Flex the ~110-word guideline toward this — don't outrun the format.`);
      }
      if (p.pacing_notes) lines.push(`- Pacing: ${String(p.pacing_notes).slice(0, 400)}`);
      if (Array.isArray(p.cta_styles) && p.cta_styles.length) {
        lines.push(`- CTA styles landing now: ${p.cta_styles.slice(0, 4).join(' · ')}. Our offer bundle is non-negotiable, but the DELIVERY rhythm can borrow from these.`);
      }
      if (Array.isArray(p.visual_motifs) && p.visual_motifs.length) {
        lines.push(`- Visual motifs to echo (still persona-anchored — BuilderCFO / SellerCFO props): ${p.visual_motifs.slice(0, 5).join(' · ')}`);
      }
      if (Array.isArray(p.avoid) && p.avoid.length) {
        lines.push(`- AVOID this week (absent from the winners): ${p.avoid.slice(0, 4).join(' · ')}`);
      }
      blocks.push(lines.join('\n'));
    }

    if (approvals.length > 0) {
      const byReason = new Map();
      for (const a of approvals) {
        const k = a.reason || 'other';
        if (!byReason.has(k)) byReason.set(k, []);
        byReason.get(k).push(a);
      }
      const lines = [];
      for (const [reason, list] of byReason) {
        lines.push(`- ${reason.toUpperCase().replace(/_/g, ' ')} (${list.length} recent win${list.length === 1 ? '' : 's'}):`);
        for (const a of list.slice(0, 3)) {
          const note = a.note ? ` — "${a.note.replace(/"/g, "'")}"` : '';
          const hook = a.hook ? `  hook: "${String(a.hook).slice(0, 140).replace(/"/g, "'")}"` : '';
          lines.push(`    • Topic: "${String(a.topic || '').slice(0, 80)}"${note}`);
          if (hook) lines.push(`     ${hook}`);
        }
      }
      blocks.push([
        'WHAT HAS WORKED (recent scripts the operator explicitly flagged as wins — lean INTO these patterns):',
        ...lines,
        '',
        'DO MORE OF these moves on this script:',
        '- "STRONG HOOK" wins: open with the same energy/structure — odd specific number, absurd-true comparison, or roast-of-the-obvious.',
        '- "GREAT TONE" wins: match the voice/register that landed. Friend on FaceTime, not keynote.',
        '- "GREAT CTA" wins: same CTA rhythm + offer-bundle placement worked — don\'t reinvent it.',
        '- "ON BRAND" wins: the persona-voice sounded right. Keep that register.',
        '- "TIGHT PACING" wins: ~110 words, breathe between sentences, finish strong.',
        '- "GREAT VISUALS" wins: persona-specific props + scene-anchored imagery. Keep per-image anchors specific.',
        '- "SHARP NUMBERS" wins: odd specific figures > round numbers. Reuse the pattern, not the number.',
        '- "GREAT FRAMEWORK" wins: the named framework stuck. Give THIS script a memorable name too.',
      ].join('\n'));
    }

    if (rejections.length > 0) {
      const byReason = new Map();
      for (const r of rejections) {
        const k = r.reason || 'other';
        if (!byReason.has(k)) byReason.set(k, []);
        byReason.get(k).push(r);
      }
      const lines = [];
      for (const [reason, list] of byReason) {
        lines.push(`- ${reason.toUpperCase().replace(/_/g, ' ')} (${list.length} recent rejection${list.length === 1 ? '' : 's'}):`);
        for (const r of list.slice(0, 3)) {
          const note = r.note ? ` — "${r.note.replace(/"/g, "'")}"` : '';
          lines.push(`    • Topic: "${String(r.topic || '').slice(0, 80)}"${note}`);
        }
      }
      blocks.push([
        'WHAT TO AVOID (rejections the operator flagged on previous scripts for this persona):',
        ...lines,
        '',
        'INTERPRET + AVOID these failure modes on the current script:',
        '- If "WEAK HOOK" appears, open harder — proof-first number or pattern-interrupt, not a generic claim.',
        '- If "WRONG TONE" appears, drop any corporate/LinkedIn-register phrasing; sound like a friend on FaceTime.',
        '- If "BAD CTA" appears, re-check the CTA against ALL FIVE requirements (product name, 14-day trial, ',
        '  30-day money-back, developer access, keyword-or-pin). Don\'t paraphrase the CTA rule away.',
        '- If "OFF BRAND" appears, lean harder into the contractor/e-com operator voice, not generic advice.',
        '- If "BAD VISUALS" appears, get every visual_prompt anchored to persona-specific props (BuilderCFO ',
        '  dashboard + jobsite / SellerCFO dashboard + Amazon|Etsy|TikTok|Shopify), no generic stock.',
        '- If "TOO LONG" / "TOO SHORT" appears, tighten the body to ~110 words total across hook+body+CTA.',
        '- If "OFF TOPIC" appears, the Topic given is the spine — every section must obviously serve that topic.',
        '- If "FACTUAL ISSUE" appears, only use numbers/claims we can defend; no made-up stats.',
      ].join('\n'));
    }

    if (blocks.length > 0) {
      feedbackBlock = '\n' + blocks.join('\n\n') + '\n';
    }
  } catch (err) {
    console.warn('[creative] could not load recent feedback (using base prompt):', err.message);
  }

  const systemInstruction = feedbackBlock
    ? `${feedbackBlock}\n${baseSystem}`
    : baseSystem;

  const userText =
    `Topic: ${topic}\n\n` +
    `Write the 45-second video script as a JSON object matching the required schema. ` +
    `Remember: Hook / Retain / Reward / CTA. No jargon. No "At Salisbury". ` +
    `Visual prompts must be photorealistic b-roll — no people, no 3D, no CGI. ` +
    `Visual anchors must be 3-10 word VERBATIM quotes from your hook/body/CTA, one per image, ` +
    `in temporal order (earliest phrase first, latest last) — the renderer times the images to ` +
    `match what the voice is saying at that moment.`;

  const parsed = await llm.generateStructured({
    system: systemInstruction,
    user:   userText,
    schema: RESPONSE_SCHEMA,
    label:  `creative:${target_persona}`,
  });

  const problems = validateScript(parsed, target_persona);
  if (problems.length) {
    throw new Error(`script validation failed: ${problems.join('; ')}`);
  }
  return parsed;
}

// -----------------------------------------------------------------------------
// Main batch: every 'Idea' row -> 'Scripted'
// -----------------------------------------------------------------------------

/**
 * Process every row currently in 'Idea' status. Sequential so we don't
 * stampede the API; a failure on one row leaves it in 'Idea' and moves on.
 *
 * @param {{ max?: number, onProgress?: (info: object) => void }} [opts]
 */
async function processIdeas(opts = {}) {
  const { max = Infinity, onProgress } = opts;
  const results = { processed: 0, scripted: 0, failed: 0, errors: [] };

  while (results.processed < max) {
    const row = await db.fetchOldestByStatus('Idea');
    if (!row) break;

    results.processed += 1;
    onProgress?.({ phase: 'start', row });

    try {
      const script = await generateScript({
        topic: row.topic,
        target_persona: row.target_persona,
      });
      await db.updateStatus(row.id, 'Scripted', { script_json: script });
      results.scripted += 1;
      onProgress?.({ phase: 'scripted', row, script });
    } catch (err) {
      results.failed += 1;
      results.errors.push({ id: row.id, topic: row.topic, error: err.message });
      onProgress?.({ phase: 'failed', row, error: err.message });
      // Row stays in 'Idea' — the state machine does its job.
    }

    if (PER_ROW_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, PER_ROW_DELAY_MS));
    }
  }
  return results;
}

// -----------------------------------------------------------------------------
// Scheduler (symmetric with researcher.js)
// -----------------------------------------------------------------------------
let _timer = null;

/**
 * Periodically drain the 'Idea' queue. First run fires immediately.
 * Default interval: 10 minutes (scripting is cheap; we want ideas to
 * flow through quickly so downstream stages have work).
 */
function start({ intervalMs = 10 * 60 * 1000 } = {}) {
  stop();
  const tick = async () => {
    try {
      const r = await processIdeas();
      // eslint-disable-next-line no-console
      console.log(`[creative] processed ${r.processed} (scripted ${r.scripted}, failed ${r.failed})`);
      for (const e of r.errors) console.warn(`[creative] #${e.id}: ${e.error}`);
    } catch (err) {
      console.error('[creative] batch failed:', err.message);
    }
  };
  tick();
  _timer = setInterval(tick, intervalMs);
  return stop;
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * Generate a script for ONE specific row by id. Used by the dashboard
 * "Run next stage" button so operators can push a targeted Idea row through
 * scripting without waiting for the orchestrator's tick or the queue order.
 * Throws on failure; success advances the row to 'Scripted' like processIdeas.
 */
async function processIdeaRow(row) {
  if (!row) throw new Error('processIdeaRow: row is required');
  if (row.status !== 'Idea') {
    throw new Error(`processIdeaRow: row #${row.id} is in status "${row.status}", not Idea`);
  }
  const script = await generateScript({
    topic: row.topic,
    target_persona: row.target_persona,
  });
  return await db.updateStatus(row.id, 'Scripted', { script_json: script });
}

module.exports = {
  processIdeas,
  processIdeaRow,
  generateScript,
  systemPromptFor,
  start,
  stop,
  RESPONSE_SCHEMA,
};

// -----------------------------------------------------------------------------
// Self-test — `node creative.js`
// -----------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log('--- Creative Agent self-test ---');
    if (!GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set. Set it in your env and re-run.');
      console.error('  PowerShell:  $env:GEMINI_API_KEY="..."');
      console.error('  bash:        export GEMINI_API_KEY=...');
      process.exit(1);
    }
    console.log(`Model: ${GEMINI_MODEL}`);
    console.log('DB before:', await db.getCounts());

    const res = await processIdeas({
      onProgress: (ev) => {
        if (ev.phase === 'start')     console.log(`\n>>> #${ev.row.id} [${ev.row.target_persona}] ${ev.row.topic}`);
        if (ev.phase === 'scripted')  console.log(`   OK  hook: "${ev.script.hook}"`);
        if (ev.phase === 'failed')    console.log(`   FAIL ${ev.error}`);
      },
    });

    console.log('\n--- Summary ---');
    console.log(`processed: ${res.processed}, scripted: ${res.scripted}, failed: ${res.failed}`);
    console.log('DB after:', await db.getCounts());

    if (res.failed > 0) process.exit(1);
  })();
}
