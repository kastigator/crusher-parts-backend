# System Refactor Analysis

Обновлено: 2026-07-30.

Эта папка больше не является архивом старых вариантов архитектуры. Старые файлы `01`-`11` удалены, потому что они тянули устаревшую OEM/original-parts/standard-parts логику и путали дальнейшую разработку.

Актуальный handoff по классификатору, BOM модели и карточке позиции:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/12_current_handoff_2026-07-03.md
```

Актуальный handoff по коммерческому контуру, поставщикам, supplier parts и складу:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/13_commercial_supplier_warehouse_refactor_plan_2026-07-26.md
```

Новый чат должен читать их после:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/PROJECT_CONTEXT.md
```

Текущая архитектура:

```text
Classifier -> equipment model -> manufacturer BOM -> position card -> supplier/commercial/warehouse contour
```

Если старые markdown-файлы будут восстановлены из истории Git или другой ветки, использовать их только как исторический материал. Они не определяют текущую архитектуру.
