FROM node:20-alpine

WORKDIR /app

# Install deps в отдельном слое — кешируется при отсутствии изменений в package*.json
COPY package*.json ./
RUN npm install --omit=dev

# Копируем исходники
COPY src ./src
COPY scripts ./scripts

# Создаём папки под runtime-данные (volume замаунтит сверху)
RUN mkdir -p /app/data /app/config

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "src/index.js"]
