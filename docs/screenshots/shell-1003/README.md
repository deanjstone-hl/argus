---
summary: "Screenshots for argus#1003: ops-hub-web, watchtower and email on the design-system v3.8.0 curve-safe shell, at 393x852 and 852x393 with emulated iPhone insets"
read_when:
  - "checking how the argus web apps look on an iPhone, or re-checking the shell adoption in #1003"
---

# Shell adoption screenshots (argus#1003)

Chromium with `Emulation.setSafeAreaInsetsOverride` standing in for an iPhone:
portrait 393x852 with insets top 59, bottom 34; landscape 852x393 with left and right 59,
bottom 21. Apps run from their production builds against fakes (the ops hub's e2e server;
stubbed Supabase and checks API for watchtower; stubbed `/api` for email). Nothing is deployed.

Files are `<app>-<view>-<portrait|landscape>.png`; email also has `-desktop` (1280x800)
to show the card layout from `lg` is unchanged.
