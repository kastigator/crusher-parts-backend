# System Refactor Analysis

Обновлено: 2026-07-03.

Эта папка больше не является архивом старых вариантов архитектуры. Старые файлы `01`-`11` удалены, потому что они тянули устаревшую OEM/original-parts/standard-parts логику и путали дальнейшую разработку.

Актуальный файл только один:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/12_current_handoff_2026-07-03.md
```

Новый чат должен читать его после:

```text
/Users/aleksandrlubimov/project/crusher-parts-backend/PROJECT_CONTEXT.md
```

Текущая архитектура:

```text
Classifier -> equipment model -> manufacturer BOM -> position card -> supplier/commercial/warehouse contour
```

Если старые markdown-файлы будут восстановлены из истории Git или другой ветки, использовать их только как исторический материал. Они не определяют текущую архитектуру.
