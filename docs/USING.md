# Using PerfoAds MCP

You never call the tools yourself. You talk to your AI app (Claude, ChatGPT, Cursor) in plain words, and it picks the tools. This page shows what you can ask, and what happens next.

Not set up yet? Do [Setup](SETUP.md) first, then come back.

## In short

- **Looking is free and safe.** Ask anything about your accounts. Nothing changes.
- **Audits say what is wrong.** Each problem comes with the numbers behind it. How to fix it is up to you.
- **Changes need you.** Every change waits for your approval on a page outside the chat. The AI saying "yes" approves nothing.
- **Changes are off at first.** You switch them on per account in your policy file (see [step 4](#4-make-a-change)).

## 1. Check it works

Say:

- "Check my PerfoAds setup."
- "Which Google Ads accounts can you see?"

The first runs `doctor`: it tests the sign-in, the access level and the policy file, and says what to fix. The second lists every account, including those under manager accounts.

Tip: name the account in every request ("in the Acme account", or its 10-digit id). If you have several, the AI must not guess.

## 2. Look around

Ask the way you would ask a colleague:

- "Give me an overview of the Acme account for the last 30 days."
- "Which campaigns spent the most last week, and what did they bring in?"
- "Show the search terms from the last 14 days that cost money and never converted."
- "List keywords with a low Quality Score."
- "What are the budgets and bid strategies of all live campaigns?"
- "Which negative keywords and shared negative lists does campaign X use?"
- "Show the ads and assets of ad group Y."
- "Which conversions are set up, and which count towards bidding?"
- "What did anyone change in this account in the last 7 days?"
- "Give me keyword ideas for 'leather mugs'." (needs Basic or Standard access)

Answers come as a short summary first. Ask "show more" for the next page of rows. Money is shown in the account's own currency.

Need something none of these cover? Ask anyway. The AI can run one read-only Google Ads query (`query_gaql`) for it.

## 3. Run an audit

Say:

- "Run a full audit of the Acme account."

The AI first takes a snapshot of the account (`build_snapshot`), then runs all 168 checks on it (`run_checks`). In apps that show MCP prompts, the `weekly_audit` prompt does the same in one step.

What you get back, per check:

- **Problem found:** what is wrong, where (campaign, ad group, keyword), and the numbers that prove it.
- **Not run:** the check could not run, with the reason (for example, not enough data yet). Not run never means "fine".
- **Info:** worth knowing, not a problem.
- **Clean:** checked, nothing wrong.

Follow-ups that work well:

- "Explain check X." (`explain_check`: what it looks at and why it matters)
- "Show only the problems in campaign Z."
- "Show only the high-severity problems."

The list of all checks: [CHECKS.md](CHECKS.md).

## 4. Make a change

Changes are off until you allow them. Open `policy.yaml` in your settings folder (`~/.config/perfoads-mcp/` on Mac and Linux, `%APPDATA%\perfoads-mcp\` on Windows) and list the account under `write`:

```yaml
version: 1
accounts:
  allow: ["123-456-7890"]
  write: ["123-456-7890"]
```

Start on a Google Ads test account. The [example file](../examples/policy.example.yaml) adds spend limits, and [POLICY.md](POLICY.md) explains every setting. Run `npx perfoads-mcp policy check` to see what your file allows.

Google usually shows test accounts as "closed". That alone doesn't stop changes, and test accounts never show ads.

Then ask for the change in plain words:

- "Lower the budget of campaign X to 40 a day."
- "Pause campaign Y."
- "Change the target ROAS of campaign Z to 400%."
- "Add 'free' and 'cheap' as phrase-match negative keywords to campaign X."
- "Add these 5 keywords to ad group Y, phrase match."
- "Pause the keyword 'red shoes' in ad group Y."
- "Change headline 3 of the ad in ad group Y to 'Free returns for 60 days'."
- "Add a sitelink 'Size guide' to campaign X, linking to yoursite.com/size-guide."

What happens:

1. **The AI proposes it.** The server reads the live values, checks your policy limits, and has Google test the change without applying it.
2. **You approve it.** A page opens in your browser (only on your computer). It shows the account, the exact change, every campaign it touches, and the AI's reason in a separate "unverified" box. Approve with the 6-character code on that page, or reject.
3. **It is sent once.** If the account changed since you approved, nothing is sent and you are told why.
4. **It is checked.** The server reads the account again to confirm the change landed.

Approval links expire after 10 minutes. If one expires, ask the AI to propose the change again.

## 5. Launch a Search campaign

Say what you want in plain fields:

- "Create a Search campaign 'Mugs US' with 30 a day, Maximize conversions, United States, English, one ad group 'Leather mugs' with these keywords, and this ad: ..."

The campaign is **always created paused**. Check it in Google Ads, then say "switch on campaign 'Mugs US'". That is a second change, with its own approval and your spend limits.

## 6. Undo and history

- "What did you change this week?" (`list_changes`)
- "Undo the budget change on campaign X." (`undo_change`)

An undo is a new change with its own approval. Most changes can be undone for 30 days. A new campaign can only be undone while it has never run. The full table: [E2E-COVERAGE.md](E2E-COVERAGE.md#undo-per-type).

## 7. Stop everything

Set `kill_switch: true` in `policy.yaml`. From the next check on, every change is refused, undo included. Reading still works.

## When something fails

- Say "check my PerfoAds setup" first. `doctor` names the problem and the fix.
- "Not approved for production": your Google Cloud project only has Test access, which reaches test accounts only. Apply for Explorer access ([Setup, step 6](SETUP.md#6-apply-for-explorer-access)).
- Out of daily requests: Google limits requests per day by access level. On Explorer that is 2,880 a day for live accounts and 15,000 for test accounts. The allowance refills within a day. The limit belongs to your own Google Cloud project, so nobody else uses it up. Hitting it often? Apply for Basic (15,000 a day on live accounts) ([Setup, step 6](SETUP.md#6-apply-for-explorer-access)).
- Everything else: [open an issue](https://github.com/vilovibe/perfoads-mcp/issues).

Every tool and input in full: [TOOLS.md](TOOLS.md).
