FROM node:25-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Этап сборки
FROM node:25-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# Финальный образ
FROM node:25-alpine AS app
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/src ./src
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/eslint.config.mjs ./
EXPOSE 3013

# Устанавливаем ENTRYPOINT для npm, чтобы CMD определял конкретный скрипт
ENTRYPOINT ["npm", "run"]