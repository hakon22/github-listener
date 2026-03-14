## GitHub/GitLab Listener

Микросервис для обработки вебхуков GitHub и GitLab, анализа изменений кода с помощью ИИ и отправки отчётов в Telegram.

Сервис:

- принимает вебхуки `push` и `merge_request`/`pull_request` от GitLab/GitHub;
- анализирует изменённые файлы и затронутые ими файлы (impact analysis);
- для каждого файла: ESLint, TypeScript, проверки безопасности и производительности, эвристики изменений сигнатур;
- обогащает результаты через LLM (OpenAI);
- пишет краткое HTML‑резюме и топ проблем в Telegram.

---

## Анализ кода

- **Типы файлов**: `.ts`, `.tsx`, `.js`, `.jsx` — полный анализ (ESLint, TypeScript, безопасность, производительность, логические изменения). Файлы `.html` — только проверки безопасности и производительности.
- **Impact analysis (затронутые файлы)**: помимо файлов из коммита/PR анализируются файлы, которые импортируют изменённые модули (по графу относительных импортов). Содержимое подгружается из репозитория по API; лимиты: до 200 файлов при обходе дерева, до 50 дополнительных затронутых файлов.
- **Управление**: переменная окружения `IMPACT_ANALYSIS_ENABLED` — при значении `false` анализ затронутых файлов отключается, анализируются только изменённые (см. раздел «Переменные окружения»).

---

## Стек

- **Node.js**, **TypeScript**
- **Express** — HTTP‑сервер (`src/main.ts`)
- **Telegraf** — Telegram Bot API
- **LangChain + OpenAI** — LLM и эмбеддинги
- **typescript-ioc** — IoC‑контейнер
- **winston** — логирование в файлы с ротацией
- Docker / docker-compose для деплоя

---

## Переменные окружения

Основные переменные (файл `.env`):

- **Telegram / сеть**
  - `TELEGRAM_BOT_TOKEN` — токен Telegram‑бота.
  - `TELEGRAM_CHAT_ID` — chat id администратора для уведомлений.
  - `PROXY_USER`, `PROXY_PASS`, `PROXY_HOST` — опционально, настройки SOCKS‑прокси для Telegram.
- **Режимы запуска**
  - `NODE_ENV` — `development` или `production` (определяет polling / webhook режим).
  - `PORT` — порт HTTP‑сервера Express (по умолчанию `3013`).
- **GitLab**
  - `GITLAB_URL` — URL GitLab.
  - `GITLAB_TOKEN` — токен доступа для GitLab API.
- **GitHub**
  - `GITHUB_API_URL` — URL GitHub API.
  - `GITHUB_TOKEN` — доступ для GitHub API.
  - `GITHUB_SECRET` — secret GitHub API.
- **Анализ кода**
  - `IMPACT_ANALYSIS_ENABLED` — при значении `false` отключается поиск и анализ затронутых файлов (по умолчанию включено).
- **AI‑модели (через LangChain)**
  - `OPENAI_API_KEY` - API ключ модели
  - `OPENAI_BASE_URL` - Base url модели
  - `OPENAI_MODEL` - Название модели
  - `OPENAI_EMBEDDING_MODEL` - Название модели, которая работает с эмбеддингом
- **Docker**
  - `IS_DOCKER` — флаг для специфических настроек внутри контейнера (опционально).

---

## Скрипты npm

- `npm run build` — компиляция TypeScript в `dist` (tsc + tsc-alias).
- `npm run start:bot:dev` — запуск сервиса в dev‑режиме (`NODE_ENV=development`, `tsx src/main.ts`).
- `npm run start:bot:prod` — запуск собранного сервиса (production, `node dist/main.js`).
- `npm run start:bot:docker:dev` — запуск внутри контейнера в dev‑режиме (`IS_DOCKER=TRUE`, `NODE_ENV=development`).
- `npm run start:bot:docker:prod` — запуск внутри контейнера в production‑режиме (`IS_DOCKER=TRUE`, `NODE_ENV=production`).
- `npm run lint` — проверка кода ESLint по `src`; автоисправление: `npm run lint -- --fix`.

---

## Локальный запуск

1. Установить зависимости:

```bash
npm ci
```

2. Настроить `.env` (минимум: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GITLAB_TOKEN` и/или `GITHUB_TOKEN`, `GITHUB_SECRET`).

3. Запустить в режиме разработки:

```bash
npm run start:bot:dev
```

Сервис поднимет HTTP‑сервер на `http://localhost:3013`.

---

## Сборка и запуск в Docker

### Production

Образ — многоэтапная сборка (зависимости → сборка TypeScript → финальный образ с `dist`):

```bash
docker build -t github-listener .
```

Запуск через `docker-compose.prod.yml`:

```bash
docker compose -f docker-compose.prod.yml up -d
```

Ожидается, что:

- в `.env` заданы переменные окружения (Telegram, GitLab/GitHub, модели);
- логи пишутся в `/srv/logs` на хосте (volume в compose‑файле);
- приложение слушает порт **3013**.

### Development

Сборка и запуск через `docker-compose.dev.yml`:

```bash
docker compose -f docker-compose.dev.yml up -d
```

Образ собирается из `Dockerfile.dev` (сборка в образе, в контейнере запускается `start:bot:docker:dev`). Порт **3013**, логи — в указанный каталог на хосте (в примере `C:/srv/logs`).

---

## Деплой (GitHub Actions)

При пуше в ветку `production` (или по ручному запуску workflow) выполняется:

1. **Тесты** — отдельный шаг: `make install`, `make test`; деплой не запускается, если тесты падают.
2. Сборка Docker‑образа и push в Docker Hub (`DOCKER_USERNAME/amber-bot:latest`).
3. Копирование `docker-compose.prod.yml` на сервер.
4. На сервере: `docker pull`, `docker compose down`, `docker compose up -d`.

Необходимые секреты репозитория: `DOCKER_USERNAME`, `DOCKER_TOKEN`, `SERVER_HOST`, `SERVER_USER`, `AM_PROJECTS_SSH_PRIVATE_KEY`.
