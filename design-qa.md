# Design QA — Five-item primary navigation

## Final result

**passed**

## Source and implementation

- Source reference: `/Users/hexiaobo/.codex/attachments/56c49cd4-c967-42e6-929b-8466b181f669/codex-clipboard-cbcea15e-ac1b-4d44-b2f1-b4737f0c46b0.png`
- Final desktop capture: `docs/test-evidence/primary-navigation-five-items-desktop.png`
- Final mobile capture: `docs/test-evidence/primary-navigation-five-items-mobile.png`
- Side-by-side comparison: `docs/test-evidence/primary-navigation-five-items-comparison.png`
- Production build: `56d9efb5a9f7fb8d6eeb5ae46215bbd62c236eab`

## Capture conditions

- Source bitmap: 1158 × 650 px. Its browser zoom and device-pixel ratio were not embedded in the attachment.
- Implementation viewport: 1158 × 650 CSS px at device-pixel ratio 1.
- Browser capture bitmap: 1152 × 647 px because the Chrome capture surface trims its frame. It was normalized to 1158 × 650 only for the side-by-side comparison.
- Source state: legacy “更多” menu open over the system/version view.
- Implementation state: new default route `#team`, with “AI 员工” active and all five direct destinations visible.
- Mobile state: 390 × 844 CSS px with the navigation overlay open.

The source and implementation states intentionally differ: the requested change removes the legacy dropdown and hidden group tabs, then makes the five requested destinations direct primary-navigation items.

## Visual comparison

- Copy: exact visible order is `AI 员工` → `额度` → `Token用量` → `备份` → `系统健康`.
- Navigation structure: the legacy “更多” control and its secondary items are absent. No grouped sub-tabs are rendered.
- Existing product system: brand mark, type, colors, border treatment, active mint state, spacing scale, and header controls remain on the current production design system.
- Layout: all five entries fit on one desktop row without overlap or clipping at the comparison viewport.
- Mobile: the overlay fills the 390 × 844 viewport; all five entries are readable and the active state is visible.
- Assets: the existing production brand logo is reused; no replacement or approximate asset was introduced.

No unresolved P0, P1, or P2 visual issues remain.

## Interaction checks

- `AI 员工` → `#team` → `page-team`
- `额度` → `#analysis/limits` → `page-limits`
- `Token用量` → `#analysis/tokens` → `page-tokens`
- `备份` → `#backups` → `page-backups`
- `系统健康` → `#system` → `page-health`
- Exactly one primary item receives `aria-current="page"` for each destination.
- An empty or invalid route falls back to `AI 员工`.
- Mobile menu opens, exposes exactly the five requested entries, navigates, and closes after selection.
- Production console errors during the verification path: none.

## QA history

1. Desktop production verification passed for labels, order, routes, active states, and hidden legacy navigation.
2. Mobile verification found a P1 issue: the existing header `backdrop-filter` constrained the fixed overlay to the 80 px header height.
3. Added the mobile open-state backdrop-filter override.
4. Production verification found the old `style.css?v=6` still cached, so the cache key was advanced to `v=7`.
5. Re-verified production at `56d9efb`: header backdrop is `none` while open, navigation rectangle is 384 × 844 in a 390 × 844 viewport, all five labels are visible, and selection closes the menu.
