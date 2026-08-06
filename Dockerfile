FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_BUILD_SHA=unknown
ENV VITE_BUILD_SHA=$VITE_BUILD_SHA
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY index.html ./
COPY xbox.html ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
