# reactless-jsx

Compile JSX into a flat `JSXRoot` object – no React, no runtime.

## Install

npm install reactless-jsx

## Usage as Babel plugin

`babel.config.json`:
{
"plugins": ["reactless-jsx"]
}

## Usage standalone

const compile = require('reactless-jsx/standalone');
const code = compile(`<div>hello</div>`, { filename: 'test.jsx' });
console.log(code);
