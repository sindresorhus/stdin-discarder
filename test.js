import test from 'ava';
import stdinDiscarder from './index.js';

// TODO: Find a way to test this.

test('main', t => {
	stdinDiscarder.start();
	stdinDiscarder.stop();
	t.pass();
});
