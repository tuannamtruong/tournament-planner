# Storyboard — Tournament Planner (for non-technical readers)

> A plain-language walkthrough of a tournament day, told as a story. No jargon,
> no code. If you've never seen the app, start here. For the detailed feature
> list see [Features.md](Features.md).

## The cast

- **Mai — the organizer.** She sits at one laptop and runs the whole event from
  it. Hers is the only computer that can change anything.
- **The scorekeepers** at each court. They write set scores on paper or read
  them out to Mai.
- **The crowd** — players, parents, friends. They watch the results on their
  phones.

## The one-sentence idea

> Mai types everything into an app on her laptop. When she's ready, she presses
> **Publish**, and a simple results web page updates for everyone watching on
> their phones.

There is no shared online system the crowd can change — only Mai's laptop holds
the real data. That keeps it simple, cheap, and impossible for anyone to mess up
by accident.

---

## Scene 1 — The night before: load the players

Mai opens the app on her laptop. She goes to the **Participants** screen and
either types each player in (name, club, their event like *Men's Singles*, their
skill level, and a seeding number) or pastes a whole spreadsheet at once.

> 💭 *Think of it as a guest list. Everyone who's playing goes on it first.*

---

## Scene 2 — Sorting players into groups

On the **Groups** screen, Mai creates the little round-robin pools — the groups
where everyone plays everyone. She picks the event and skill level for a group,
and the app only offers her the players who fit and who aren't already in
another group, so nobody gets double-booked.

![The Groups screen](images/admin-groups.png)

When she presses **Generate next round**, the app figures out who plays whom and
when, automatically. She never has to draw up a schedule by hand.

> 💭 *Like dealing cards into fair piles, then letting the app write the
> fixture list for each pile.*

---

## Scene 3 — The matches begin

A scorekeeper at Court 2 reports a score. Mai opens the **Matches** screen,
finds that match, and types the set scores. She taps **▶** when a match starts
and **✓** when it's finished — the app quietly records the times for her.

![The Matches screen](images/admin-matches.png)

A **Live now** strip at the top shows her every match currently being played, so
she always knows what's on court.

> 💭 *If a player pulls out, one tap marks them withdrawn and the app awards all
> their remaining matches to their opponents — no manual cleanup.*

As scores go in, the app keeps each group's **standings table** up to date and
ranked correctly (most wins first, with sensible tie-breakers). Mai doesn't do
any maths.

---

## Scene 4 — The knockout rounds

Once groups are done, Mai goes to the **Bracket** screen and creates a knockout
ladder for each event. She tells it how many players; the app builds the ladder
and handles odd numbers by giving some players a free pass (a "bye") in the first
round.

![The Bracket screen](images/admin-bracket.png)

As she enters each result and taps the winner, that winner automatically moves up
to the next rung of the ladder. The bracket fills itself in toward the final.

---

## Scene 5 — Showing the crowd: the Publish button

Here's the key moment. Everything Mai has typed so far lives **only on her
laptop**. The crowd hasn't seen any of it yet.

At the top of her screen is a small coloured dot and a **Publish** button:

- 🟢 **green** — everyone's looking at the latest results.
- 🟡 **yellow** — Mai has made changes the crowd hasn't seen yet.

When the dot is yellow and Mai is ready, she presses **Publish**. The new
results are sent out to the public web page, and the dot turns green.

> 💭 *Nothing goes public until Mai decides. She's in control of the timing —
> handy when she wants to finish entering a whole round before revealing it.*

---

## Scene 6 — The crowd watches on their phones

A spectator scans a QR code (or types the web address) and sees a clean,
read-only results page — group tables on one tab, knockout brackets on another.

![What the crowd sees — group stage](images/index.png)

![What the crowd sees — knockout brackets](images/knockout.png)

The page doesn't update by itself; spectators just **refresh** (pull down /
reload) to get the newest results. That's deliberate — it keeps the whole thing
nearly free to run and means nothing can break under a crowd.

---

## Scene 7 — When the Wi-Fi drops

Venue Wi-Fi is flaky. No problem: Mai keeps typing scores even with no internet.
The app saves everything locally and the dot just stays yellow. The moment the
connection comes back, she presses **Publish** and the crowd is caught up. **She
never loses work.**

---

## Scene 8 — "Oops, wrong score"

If Mai mistypes, the **Pending** screen lists every change she's made since the
last Publish, newest first, in plain English. She can **undo back to any point**
with one click. And every few minutes the app quietly saves a backup, so even a
laptop crash isn't a disaster.

---

## Why it's built this way (in one breath)

- **One laptop is the boss.** Only Mai's machine changes anything — no
  confusion about which version is real.
- **Publish is a deliberate button, not automatic.** Mai chooses when the crowd
  sees updates.
- **The public page is read-only and refresh-to-update.** Cheap to run (the
  whole event costs under $2), and nothing the crowd does can affect the data.
- **It keeps working offline.** Bad Wi-Fi can't stop the event.

That's the whole system: type on the laptop → press Publish → the crowd
refreshes their phones.

---

*Want more detail? [Features.md](Features.md) lists every button and screen;
[Requirements.md](Requirements.md) lists the rules the app must follow.*
