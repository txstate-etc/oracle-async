FROM txstatemws/node-oracle
WORKDIR /usr/app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src src
COPY test test

ENTRYPOINT [ "npm" ]
CMD [ "run", "mocha", "--silent" ]
