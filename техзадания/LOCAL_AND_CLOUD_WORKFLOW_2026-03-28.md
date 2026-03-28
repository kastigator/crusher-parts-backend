# Локальная работа и деплой: упрощенная схема

Этот файл фиксирует простую рабочую модель без путаницы между `.env.local`, локальной разработкой и облачным деплоем.

## 1. Три режима работы

### Локальная разработка

Используется, когда вы пишете код на этом компьютере.

Самый удобный запуск одной командой:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run dev:all
```

Эта команда поднимает backend локально через `cloud-sql-proxy` и frontend через `vite`.

Backend:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run start:local
```

Что делает команда:

- поднимает `cloud-sql-proxy`
- загружает `/Users/aleksandrlubimov/project/crusher-parts-backend/.env.local`
- запускает backend в `NODE_ENV=local`

Frontend:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
npm run dev
```

В этом режиме frontend берет `VITE_*` из локального окружения Vite, а backend работает локально.

В VS Code можно запускать это прямо кнопками в `Run and Debug`.

Конфигурация:

`/Users/aleksandrlubimov/project/crusher-parts-backend/.vscode/launch.json`

И через меню `Terminal -> Run Task`.

Конфигурация задач:

`/Users/aleksandrlubimov/project/crusher-parts-backend/.vscode/tasks.json`

Основные кнопки:

- `Локальная разработка: backend + frontend`
- `Backend: локально`
- `Frontend: локально`
- `Деплой: backend`
- `Деплой: frontend`
- `Деплой: backend + frontend`

### Облачный тестовый режим

Используется, когда нужно проверить изменения по публичному URL.

Backend deploy:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run deploy:backend
```

Frontend deploy:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run deploy:frontend
```

Или из frontend:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
npm run deploy:cloud
```

Обе команды запускают соответствующий `Cloud Build` trigger и ждут финального статуса сборки.

### Полный облачный прогон

Если менялись и backend, и frontend:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run deploy:all
```

## 2. Где живут переменные окружения

### Backend локально

Источник:

`/Users/aleksandrlubimov/project/crusher-parts-backend/.env.local`

Локальный backend использует именно этот файл.

### Backend в облаке

Источник:

- обычные env vars в `Cloud Run`
- секреты в `Secret Manager`

Секреты backend:

- `backend-db-password`
- `backend-jwt-secret`
- `backend-refresh-secret`

Production backend больше не зависит от локального `.env.local`.

### Frontend локально

Frontend запускается через `vite` локально.

### Frontend в облаке

Источник:

`/Users/aleksandrlubimov/project/crusher-parts-frontend/cloudbuild.yaml`

и substitutions у `Cloud Build` trigger `deploy-crusher-frontend`.

Ключевая переменная:

- `_VITE_API_URL`

## 3. Текущая рабочая схема

Локально:

- backend: локально
- frontend: локально
- БД: через `cloud-sql-proxy`

В облаке:

- backend: `Cloud Run`
- frontend: статическая публикация в `frontend-parts-site`
- backend URL для облачного теста задается через frontend trigger

## 4. Что важно не путать

`.env.local` нужен для локальной работы.

Он не является источником production-конфигурации.

Production-конфигурация сейчас разделена так:

- backend secrets: `Secret Manager`
- backend runtime env: `Cloud Run`
- frontend env: `Cloud Build trigger substitutions`

## 5. Рекомендуемый повседневный сценарий

1. Пишете и проверяете код локально:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run start:local
```

и в отдельном окне:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-frontend
npm run dev
```

2. Если локально все нормально, деплоите backend:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run deploy:backend
```

3. Если frontend тоже менялся, деплоите frontend:

```bash
cd /Users/aleksandrlubimov/project/crusher-parts-backend
npm run deploy:frontend
```

4. Проверяете облачный URL.

## 6. Когда не надо деплоить frontend

Если вы изменили только backend и frontend не зависит от новых `VITE_*` или новых фронтовых экранов, достаточно backend deploy.

## 7. Когда не надо деплоить backend

Если вы изменили только frontend и API-контракты backend не трогались, достаточно frontend deploy.

## 8. Почему схема сейчас нормальная

Она отделяет:

- локальную разработку
- облачный тест
- инфраструктурные секреты

И не заставляет вас думать, что `.env.local` должен magically попасть в production.
