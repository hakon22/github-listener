## GitHub/GitLab Listener

Микросервис для обработки вебхуков GitHub и GitLab, анализа изменений кода с помощью ИИ и отправки отчётов в Telegram.

Сервис:

- принимает вебхуки `push` и `merge_request`/`pull_request` от GitLab/GitHub;
- анализирует изменённые файлы и затронутые ими файлы (impact analysis);
- для каждого файла: ESLint, TypeScript, проверки безопасности и производительности, эвристики изменений сигнатур;
- обогащает результаты через LLM (OpenAI);
- пишет краткое HTML‑резюме и топ проблем в Telegram (до 5 пунктов, со сниппетами кода; для файлов вне коммита содержимое подгружается по API). При ошибке API (например, 404 Ref Not Found) выводится понятное пояснение, что анализ не выполнялся (ветка/коммит недоступны).

---

## Анализ кода

- **Типы файлов**: анализируются исходники `.ts`, `.tsx`, `.js`, `.jsx` (ESLint + логические изменения). Markdown и lock‑файлы (`.md`, `package-lock.json`) из анализа исключаются.
- **Impact analysis (затронутые файлы)**: помимо файлов из пуша/PR анализируются файлы, которые импортируют изменённые модули. Содержимое дополнительно затронутых файлов подгружается через драйвер (`ScmPushAnalysisDriver.getSnapshot`), лимит по умолчанию — до 50 файлов. Управляется переменной окружения `IMPACT_ANALYSIS_ENABLED` (см. раздел «Переменные окружения»).
- **ESLint‑проверки**: `CodeAnalyzerService` запускает ESLint с базовой конфигурацией `eslint:recommended` + `@typescript-eslint/recommended` и возвращает только проблемы с `severity: "error"`. Переопределение/выключение правил выполняется через модификацию `baseConfig` в `code-analyzer.service.ts`.
- **Логические изменения**:
  - **Изменения схемы сущностей** (`logical-entity-schema-change` → `logical-entity-usage`):
    - детектор в `CodeAnalyzerService` фиксирует изменение схемы ORM‑сущности (добавленные/удалённые поля);
    - `AIService.getEntitySchemaChangeIssues` по графу импортов и дополнительным путям (`getSourceFilePathsForEntityUsage`) находит файлы использования сущности, нумерует строки и передаёт контекст в модель (`entitySchemaChangePrompt`);
    - модель возвращает конкретные проблемы использования (`logical-entity-usage`). Дополнительный AI‑анализ использования сущностей можно отключить переменной `ENTITY_SCHEMA_USAGE_ANALYSIS_ENABLED=false`.
  - **Изменения сигнатур функций/методов** (`logical-function-signature-change`):
    - фиксируются изменения параметров и их использования, проверяются вызовы по проекту;
    - при необходимости можно полностью убрать этот тип проблем из итогового отчёта через переменную `ANALYSIS_EXCLUDED_RULES` (см. раздел «Переменные окружения»).
  - **Проблемы загрузки данных**:
    - при `USE_UNIFIED_AI_ANALYSIS=true` используется единый AI‑анализ изменённых файлов (`getUnifiedAnalysisIssues`) — один запрос к модели, которая ищет типовые проблемы (безопасность, загрузка данных, контракты и т.д.);
    - при `USE_UNIFIED_AI_ANALYSIS=false` работает детальный пайплайн анализа загрузки данных с traceability и call sites (`getLogicalDataLoadingIssues`), модель ищет обращения к полям/связям, которые не подгружаются запросом (TypeORM relations, Prisma include/select, Knex, raw SQL и т.д.).

### Какие проблемы анализируются (типы и примеры)

- **ESLint/TypeScript ошибки (severity: "error")**
  - Источник: базовый ESLint‑анализ в `CodeAnalyzerService`.
  - Типичные примеры:
    - доступ к свойству потенциально `undefined` / `null` без проверки;
    - использование несуществующей переменной/импорта;
    - некорректные сигнатуры обработчиков, промисов, async/await и т.п.
  - Внутреннее поле `severity` для таких проблем всегда `"error"` — warning/info не попадают в пайплайн.

- **Изменения схемы сущностей (`logical-entity-usage`)**
  - Сценарий: вы добавили/удалили поле в ORM‑сущности (`UserEntity.emailConfirmed` и т.п.), а где‑то в коде это поле:
    - не заполняется при создании;
    - не учитывается при формировании DTO/ответа;
    - читается, хотя по миграциям оно стало опциональным/удалено.
  - Модель получает:
    - JSON с описанием изменения схемы;
    - список файлов, где сущность используется;
    - нумерованный контент этих файлов.
  - На выходе формируются конкретные проблемы вида:
    - «В методе X при создании User не устанавливается новое поле "emailConfirmed"»;
    - `file: services/user.service.ts`, `line: 123`, `rule: logical-entity-usage`, `severity: "error"`.

- **Изменения сигнатур (`logical-function-signature-change`)**
  - Сценарий: изменили параметры функции/метода (добавили/убрали параметр, поменяли порядок), и это **может сломать существующие вызовы**.
  - Детектор фиксирует факт изменения сигнатуры и передаёт в модель JSON с деталями (`kind: "function-signature-change"`, список добавленных/удалённых параметров).
  - Модель по коду ищет реальные риски:
    - вызовы без нового обязательного параметра;
    - перепутанный порядок аргументов;
    - использование старого формата параметров при новом контракте.
  - Если модель **не находит конкретных проблем**, базовый кандидат «проверьте все места» в итоговый список не попадает.
  - В отчёт уходят только случаи, где модель нашла реальный риск рантайм‑ошибки/некорректной логики.

- **Проблемы загрузки данных / несоответствия результату запроса**
  - Сценарий: код обращается к полям/relations результата запроса, которые по коду самого запроса **не загружаются**:
    - в TypeORM забыли добавить нужную relation в `relations`/`leftJoinAndSelect`;
    - в Prisma не добавили поле в `include`/`select`;
    - в Knex/raw SQL не выбрали колонку, но дальше её читают.
  - Для детального режима (`getLogicalDataLoadingIssues`) модель получает:
    - traceability: какие функции/методы вызываются, какие у них параметры и где к ним обращаются;
    - call sites: откуда и с какими аргументами вызываются эти функции;
    - нумерованный код источников и мест использования.
  - Пример итоговой проблемы:
    - `rule: logical-query-result-mismatch`;
    - `message`: «Поле "order.delivery.address" читается, но не загружается в запросе (relations/include/select)»;
    - `impact`: «В проде возможен undefined и падение контроллера при обращении к адресу».

- **Единый AI‑анализ (`getUnifiedAnalysisIssues`)**
  - Срабатывает при `USE_UNIFIED_AI_ANALYSIS=true`.
  - Модель получает:
    - список изменённых файлов с контентом и их diff;
  - Ищет общие критические проблемы по категориям:
    - **security**: SQL‑инъекции, уязвимые конструкции, небезопасная работа с данными;
    - **performance**: потенциально очень тяжёлые запросы, неоптимальные циклы/операции с большими коллекциями, N+1 и т.п.;
    - **контракты и инварианты**: нарушения ожидаемых условий, неправильные проверки, неконсистентные обновления данных.

### Типы рекомендаций (type) и их смысл

- **`security`**
  - Проблемы, ведущие к уязвимостям: инъекции, XSS‑риски, небезопасные операции с конфиденциальными данными и т.п.
  - В Telegram‑отчёт по умолчанию всегда включаются (приоритетные).

- **`performance`**
  - Ошибки и анти‑паттерны, которые могут привести к падению/таймаутам/неприемлемому времени отклика:
    - тяжёлые запросы без лимитов;
    - N+1 в горячих местах;
    - крупные in‑memory операции вместо стримов/батчей и т.п.

- **`quality`**
  - Стиль, удобочитаемость, потенциальные улучшения, не ведущие напрямую к падению.
  - **По умолчанию не выводятся в Telegram** (отфильтрованы в `ScmReviewService`).
  - Можно явно включить через `ANALYSIS_ALLOWED_TYPES`, если нужен более «широкий» отчёт.

- **`best_practice`**
  - Рекомендации уровня «best practices» (архитектура, соглашения, улучшения API).
  - Как и `quality`, по умолчанию не попадают в Telegram.

### Формирование Telegram‑отчёта и фильтры

- Все собранные проблемы обогащаются через `AIService.getRecommendations`, который формирует рекомендации с типом:
  - `type: 'quality' | 'security' | 'performance' | 'best_practice'`,
  - но в промпте модели жёстко указано, что нужно возвращать только критические проблемы (рантайм‑ошибки, падения, security).
- `ScmReviewService.getCriticalRecommendations` отбирает проблемы, которые попадут в Telegram:
  - по умолчанию берутся только проблемы с `severity: "error"` или `type: "security"`;
  - типы `quality` и `best_practice` всегда отбрасываются по умолчанию;
  - можно явно задать список разрешённых типов через `ANALYSIS_ALLOWED_TYPES` (через запятую), например:
    - `ANALYSIS_ALLOWED_TYPES=security,performance`.
- Для тонкой фильтрации по правилам используется переменная `ANALYSIS_EXCLUDED_RULES`:
  - пример: `ANALYSIS_EXCLUDED_RULES=logical-function-signature-change,logical-entity-schema-change`;
  - такие правила полностью исключаются из итогового отчёта (даже если модель посчитала их критичными).

---

## Стек

- **Node.js**, **TypeScript**
- **Express** — HTTP‑сервер (`src/main.ts`)
- **Telegraf** — Telegram Bot API
- **LangChain + @langchain/openai** — LLM и эмбеддинги
- **typescript-ioc** — IoC‑контейнер (reflect-metadata)
- **winston** — логирование в файлы с ротацией
- **Jest** — тесты
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
- **Запросы к API GitHub/GitLab (опционально)**
  - `API_REQUEST_TIMEOUT_MS` — таймаут одного HTTP‑запроса в мс (по умолчанию `30000`). Увеличьте при нестабильной сети или долгих ответах.
  - `DELAY_BETWEEN_REQUESTS_MS` — минимальная задержка между запросами к API в мс (по умолчанию `200`). Снижает риск таймаутов и перегрузки API.
  - `GITHUB_SECRET` — secret GitHub API.
- **Анализ кода**
  - `IMPACT_ANALYSIS_ENABLED` — при значении `false` отключается поиск и анализ затронутых файлов (по умолчанию включено).
  - `LOGICAL_CHANGE_EXTRACTION_ENABLED` — при значении `false` отключается извлечение и проверка логических изменений (сигнатуры, загрузка данных через ИИ) (по умолчанию включено).
  - `USE_UNIFIED_AI_ANALYSIS` — при значении `true` для поиска проблем загрузки данных используется единый AI‑анализ изменённых файлов (**вместо** полного пайплайна с traceability и call sites). Режимы взаимоисключающие: либо единый анализ, либо детальный анализ загрузки данных.
  - `VECTOR_EMBEDDINGS_ENABLED` — при значении `false` отключается индексация изменений в эмбеддинги и семантический поиск по коду. Используйте, если эндпоинт эмбеддингов (OPENAI_BASE_URL) возвращает ответ не в формате OpenAI (`{ data: [ { embedding: number[] } ] }`).
  - `ENTITY_SCHEMA_USAGE_ANALYSIS_ENABLED` — при значении `false` отключается дополнительный AI‑анализ использования сущностей после изменения их схемы (`logical-entity-usage`); по умолчанию включено.
  - `ANALYSIS_ALLOWED_TYPES` — список типов рекомендаций, которые разрешено включать в Telegram‑отчёт (`quality`, `security`, `performance`, `best_practice`), через запятую. При отсутствии переменной используются только критические ошибки/безопасность, а типы `quality`/`best_practice` отбрасываются.
  - `ANALYSIS_EXCLUDED_RULES` — список ESLint/логических правил, которые нужно полностью исключить из итогового отчёта (например, `logical-function-signature-change,logical-entity-schema-change`).
- **Прочее**
  - `APP_NAME` — имя приложения в логах и уведомлениях об ошибках (по умолчанию `app`).
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
- `npm run start:app:dev` — запуск сервиса в dev‑режиме (`NODE_ENV=development`, `tsx src/main.ts`).
- `npm run start:app:prod` — запуск собранного сервиса (production, `node dist/main.js`). Перед запуском выполните `npm run build` (сборка в `dist`).
- `npm run start:app:docker:dev` — запуск внутри контейнера в dev‑режиме (`IS_DOCKER=TRUE`, `NODE_ENV=development`).
- `npm run start:app:docker:prod` — запуск внутри контейнера в production‑режиме (`IS_DOCKER=TRUE`, `NODE_ENV=production`).
- `npm run lint` — проверка кода ESLint по `src`; автоисправление: `npm run lint -- --fix`.
- `npm run test` — запуск тестов Jest.

**Makefile** (из корня репозитория): `make install` — установка зависимостей, `make test` — тесты, `make start-local` — запуск в dev‑режиме.

---

## Локальный запуск

1. Установить зависимости:

```bash
npm ci
```

Или через Makefile (из корня репозитория):

```bash
make install
```

2. Настроить `.env` (минимум: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GITLAB_TOKEN` и/или `GITHUB_TOKEN`, `GITHUB_SECRET`).

3. Запустить в режиме разработки:

```bash
npm run start:app:dev
```

Или:

```bash
make start-local
```

Сервис поднимет HTTP‑сервер на `http://localhost:3013`. Тесты: `make test` или `npm run test`.

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

Образ собирается из `Dockerfile.dev` (сборка в образе, в контейнере запускается `start:app:docker:dev`). Порт **3013**, логи — в указанный каталог на хосте (в примере `C:/srv/logs`).

---

## Деплой (GitHub Actions)

При пуше в ветку `production` (или по ручному запуску workflow) выполняется:

1. **Тесты** — отдельный шаг: `make install`, `make test`; деплой не запускается, если тесты падают.
2. Сборка Docker‑образа и push в Docker Hub (`DOCKER_USERNAME/amber-bot:latest`).
3. Копирование `docker-compose.prod.yml` на сервер.
4. На сервере: `docker pull`, `docker compose down`, `docker compose up -d`.

Необходимые секреты репозитория: `DOCKER_USERNAME`, `DOCKER_TOKEN`, `SERVER_HOST`, `SERVER_USER`, `AM_PROJECTS_SSH_PRIVATE_KEY`.
