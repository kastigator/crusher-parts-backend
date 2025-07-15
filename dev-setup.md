# 🛠 Dev Setup: crusher-parts-backend (локальная разработка)

Инструкция по настройке окружения для проекта `crusher-parts-backend` на новой машине (Windows/macOS/Linux).

---

## ✅ Предустановки

Убедись, что на машине установлены:

* Node.js (v18 или новее)
* npm
* Git
* VS Code (рекомендуется)

---

## 📦 Установка зависимостей

```bash
npm install
```

Установит все зависимости из `package.json`.

---

## 🚀 Запуск локального сервера с `.env.local`

### 1. Установи `cross-env` и `nodemon` (если ещё не установлены):

```bash
npm install --save-dev cross-env
npm install -g nodemon
```

### 2. Убедись, что в `package.json` есть скрипт:

```json
"start:local": "cross-env NODE_ENV=local nodemon server.js"
```

### 3. Убедись, что в `server.js` присутствует:

```js
const NODE_ENV = process.env.NODE_ENV || 'local';
dotenv.config({ path: path.resolve(process.cwd(), `.env.${NODE_ENV}`) });
```

### 4. Запусти бэкенд:

```bash
npm run start:local
```

Если всё правильно — увидишь:

```
✅ Server running on port 5050
```

---

## 🌐 Запуск фронтенда (в отдельной вкладке терминала)

```bash
npm run dev
```

Откроется [http://localhost:5173](http://localhost:5173), и он будет работать с API на `http://localhost:5050`

---

## 📁 Обязательные файлы

В корне проекта должен быть файл `.env.local` (не пушится в GitHub):

Пример:

```env
PORT=5050
DB_HOST=...
DB_PORT=3306
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
JWT_SECRET=...
CORS_ORIGIN=http://localhost:5173
```

---

## 🔒 .gitignore

Убедись, что в `.gitignore` есть:

```
node_modules
.env*
logs
.DS_Store
```

---

## ✅ Всё готово!

Теперь ты можешь запускать и отлаживать проект одинаково на любой машине:

* `npm run start:local` — бэкенд на `localhost:5050`
* `npm run dev` — фронтенд на `localhost:5173`

Серверы взаимодействуют через CORS и общую `.env.local`

---

*Этот файл можно использовать как инструкцию для новых членов команды или для быстрого развёртывания среды с нуля.*
