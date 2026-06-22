ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE}
WORKDIR /app

COPY ../package*.json ./
RUN npm install
# RUN npm install --omit=dev

COPY . ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]