# Текущий контекст задач

Обновлено: 2026-07-30.

Старые технические задания удалены намеренно. Они описывали промежуточные идеи, старый OEM-каталог, отдельные standard-parts и другие подходы, которые больше не являются целевой архитектурой.

Для нового чата читать в таком порядке:

1. `/Users/aleksandrlubimov/project/crusher-parts-backend/PROJECT_CONTEXT.md`
2. `/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/12_current_handoff_2026-07-03.md`
3. Для коммерческого контура, поставщиков, supplier parts и склада: `/Users/aleksandrlubimov/project/crusher-parts-backend/техзадания/system_refactor_analysis/13_commercial_supplier_warehouse_refactor_plan_2026-07-26.md`
4. При необходимости технических имен сущностей: `/Users/aleksandrlubimov/project/crusher-parts-backend/docs/activity-entity-types.md`
5. При работе с AI-агентом: `/Users/aleksandrlubimov/project/crusher-parts-backend/docs/ai-agent-domain-audit.md`

Главная логика системы сейчас:

```text
Классификатор -> модель оборудования -> BOM модели -> карточка позиции -> поставщики/коммерческий контур/склад
```

Не начинать новые решения от старых экранов "OEM детали", "оригинальные детали" или отдельного справочника standard parts. Если такие слова встречаются в старом коде или данных, это повод для аккуратной зачистки, а не источник новой логики.
