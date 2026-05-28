FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm ci
RUN curl https://install.example.com/setup.sh | bash
