module.exports = {
  root: true,
  extends: "eslint:recommended",
  parserOptions: {
    ecmaVersion: 9
  },
  env: {
    es6: true,
    node: true
  },
  'rules': {
    'no-undef': 2,
    'no-unused-vars': 0,
    'no-console': 0
  }
}