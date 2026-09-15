import type { Configuration } from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { rules } from './webpack.rules';

export const rendererConfig: Configuration = {
  plugins: [new MiniCssExtractPlugin()],
  module: {
    rules,
  },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
