import dts from "rollup-plugin-dts";
import resolve from "@rollup/plugin-node-resolve";
import sucrase from '@rollup/plugin-sucrase';
import external from "rollup-plugin-peer-deps-external";

const packageJson = require("./package.json");

export default [
  {
    input: 'src/index.ts',
    output: [
      {
        file: packageJson.main,
        format: "cjs",
        sourcemap: true,
      },
      {
        file: packageJson.module,
        format: "esm",
        sourcemap: true,
      },
    ],
    plugins: [
      external({
        includeDependencies: true
      }),
      resolve({
        extensions: ['.js', '.ts']
      }),
      sucrase({
        exclude: ['node_modules/**'],
        transforms: ['typescript']
      }),
    ]
  },
  {
    input: "src/index.ts",
    output: [
      {
        file: packageJson.types,
        format: "es",
        sourcemap: true,
      },
    ],
    plugins: [dts()],
  },
];