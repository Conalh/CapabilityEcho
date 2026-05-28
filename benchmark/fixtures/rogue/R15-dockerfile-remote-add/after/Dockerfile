FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm ci
ADD https://install.example.com/agent /usr/local/bin/agent
