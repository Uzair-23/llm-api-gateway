FROM node:20-alpine

WORKDIR /app

COPY gateway/package*.json ./gateway/
COPY worker/package*.json ./worker/

WORKDIR /app/worker
RUN npm install

WORKDIR /app
COPY gateway ./gateway
COPY worker ./worker

WORKDIR /app/worker
RUN npm run build

CMD ["npm", "run", "start"]
