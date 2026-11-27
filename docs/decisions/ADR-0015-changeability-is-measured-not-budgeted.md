---
id: ADR-0015
type: decision
status: accepted
date: 2026-11-20
summary: Charter 11 (stay changeable) is judged by Items merged on their first Work, the Recurring Failure Rate and the Time to Verified Resolution; the active core's lines are a trend recorded at each milestone and shown by work report, never a gate; supersedes ADR-0010.
related: [ADR-0010, ADR-0013]
---

# Changeability is measured, not budgeted in lines

Accepted 2026-11-20 by the operator: "bỏ phần chặn, giữ số đo. Charter 11
("stay changeable") được đo tốt hơn bằng các số đã có: Item merge ngay ở Work
đầu, tỷ lệ lỗi lặp lại, thời gian đến khi accept. Số dòng chỉ còn để xem xu
hướng." Supersedes [ADR-0010](ADR-0010-core-budget-rebaselined.md) (Item ir-9
in STATUS.md carries it out).

## Context

- The DP milestone grew the active core 4,840 → 5,117 lines while making it
  easier to change: the lines measured the wrong thing.
- ir-2's `core-budget` gate (fixed by ir-7) held ir-4 three times on
  2026-11-20 without finding a defect.

## Decision

1. Charter 11 is judged by Items merged on their first Work, the Recurring
   Failure Rate and the Time to Verified Resolution.
2. The core's lines (the `.ts` files of `packages/work/src` and
   `packages/artifacts/src`) are a trend: recorded at each milestone close in
   [PLAN.md](../../PLAN.md) and shown by `system work report --since` as
   `activeCoreLines: { start, end }` (counted from git on `dev`), never a gate.
3. The `core-budget` check is removed. The docs budget is a separate
   mechanism and does not change.
4. `tools/core-budget.sh` stays as a stub that exits 0, for Works whose
   criteria were pinned before the check's removal; a later cleanup deletes it
   once no running or held Work pins the old criteria.
   Deleted on 2026-11-27 (Item tidy-12): `system status` showed no running or held Work.
