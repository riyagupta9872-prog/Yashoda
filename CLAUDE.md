# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Yashoda Sadhana Tracker** is a Progressive Web App (PWA) for tracking daily spiritual practices (sadhana) within a multi-department, team-based organization (RAPP). It uses Firebase (Auth + Firestore) as its backend, with no build step — all code runs directly in the browser via CDN-loaded dependencies.

## Architecture

### Single-page app structure (no framework, no bundler)
- **index.html** (~1900 lines) — The entire app UI: login form, dashboard, sadhana form, reports, admin panel, modals, and all inline styles. Heavy use of inline `<style>` blocks at the top.
- **app.js** (~2500 lines) — All application logic in one file, organized into numbered sections:
  1. Firebase setup & config
  2. Role helpers (`isSuperAdmin`, `isTeamLeader`, `isAnyAdmin`)
  3. Helpers (time conversion, week calculation, date utilities)
  4. Excel download (XLSX export with profile headers)
  5. Auth (login, signup redirect, `onAuthStateChanged` listener)
  6. Navigation (tab switching)
  7. Reports table (weekly report rendering with collapsible week cards)
  8. Progress charts (Chart.js visualizations)
  9. Sadhana form scoring (daily entry submission with level-based scoring)
  10. Admin panel (user management, comparative reports, team filtering)
  11. Super admin — edit sadhana (modal for editing any user's entries)
  12. Date select & profile form
  13. Password modal
  14. Misc bindings
  15. Forgot password
- **signup.html** — Standalone signup page with its own Firebase init
- **style.css** — Base styles (largely superseded by inline styles in index.html)
- **sw.js** — Service worker for offline caching (network-first strategy)
- **manifest.json** — PWA manifest

### Firebase / Firestore data model
- **`users/{uid}`** — User profile document: `name`, `level` (Level-1 through Level-4), `department` (IGF/IYF/ICF_MTG/ICF_PRJI), `team` (Yashoda/Devaki/Balarama/Other), `chantingCategory`, `exactRounds`, `role` (user/teamLeader/superAdmin)
- **`users/{uid}/sadhana/{date}`** — Daily sadhana entry keyed by ISO date string, containing times (sleep, wakeup, chanting), activity minutes, scores, and computed totals
- **`users/{uid}/notifications/{id}`** — In-app notification documents

### Role-based access
- **superAdmin** — Sees all users across all departments/teams; can edit any sadhana entry, change roles/levels, delete users
- **teamLeader** — Sees users in their own team only; can view individual reports
- **user** — Can only see and fill their own sadhana

### Scoring engine
Four independent scoring functions (`calcScoreL1` through `calcScoreL4`) with different thresholds per level. Key differences:
- L1/L2: Sleep by 23:00/23:05, wake by 6:00/6:05; best-of reading/hearing counted; instrument is bonus only
- L3/L4: Stricter sleep/wake times; instrument is compulsory; L4 adds notes revision bonus and counts both reading AND hearing
- Weekly service score calculated separately via `calcServiceWeekly()`
- Sunday bonus for dress/tilak/mala via `calcSundayBonus()`
- Daily max scores: L1=105, L2=110, L3=115, L4=140

## Development

### Running locally
No build step. Serve the directory with any static file server:
```
npx serve .
# or
python -m http.server 8000
```

### Dependencies (all CDN-loaded)
- Firebase JS SDK v8.10.1 (compat) — Auth, Firestore
- Chart.js v4.4.0 — Progress charts
- SheetJS (xlsx) v0.18.5 — Excel export

### Key conventions
- Firebase config is duplicated in both `app.js` and `signup.html` — changes must be applied to both
- All state is global (`currentUser`, `userProfile`, `activeListener`)
- DOM manipulation is direct (no virtual DOM); elements referenced by `getElementById`
- The `t2m()` helper converts "HH:MM" time strings to minutes-since-midnight (with special handling for post-midnight sleep times)
- `getWeekInfo()` defines weeks as Sunday–Saturday
- NR (Not Reported) entries are auto-filled with -30 score for missed days
