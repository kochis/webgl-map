import babel from 'rollup-plugin-babel';

export default {
  input: './src/index.js',
  output: {
    file: 'dist/webgl-map.js',
    format: 'iife',
    name: 'Radar',
  },
  plugins: [
    babel({
      babelrc: false,
      exclude: 'node_modules/**',
      "presets": [
        [
          "@babel/env",
          {
            "modules": false,
            "corejs": 3,
            "targets": "defaults"
          }
        ]
      ]
    }),
  ],
};

