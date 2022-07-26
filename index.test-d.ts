import {expectType} from 'tsd';
import stdinDiscarder from './index.js';

expectType<void>(stdinDiscarder.start());
expectType<void>(stdinDiscarder.stop());
