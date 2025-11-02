import {Buffer} from 'node:buffer';
import process from 'node:process';
import test from 'ava';
import stdinDiscarder from './index.js';

const makeMockStdin = () => {
	let paused = true;
	let isRaw = false;
	const listeners = new Map();

	const on = (event, fn, {prepend = false} = {}) => {
		const array = listeners.get(event) ?? [];
		if (prepend) {
			array.unshift(fn);
		} else {
			array.push(fn);
		}

		listeners.set(event, array);
		return mock;
	};

	const off = (event, fn) => {
		const array = listeners.get(event) ?? [];
		const index = array.indexOf(fn);
		if (index >= 0) {
			array.splice(index, 1);
		}

		return mock;
	};

	const emit = (event, ...arguments_) => {
		for (const fn of listeners.get(event) ?? []) {
			fn(...arguments_);
		}
	};

	const mock = {
		isTTY: true,
		get isRaw() {
			return isRaw;
		},
		setRawMode(v) {
			isRaw = Boolean(v);
		},
		isPaused() {
			return paused;
		},
		pause() {
			paused = true;
			return mock;
		},
		resume() {
			paused = false;
			return mock;
		},
		on(event, fn) {
			return on(event, fn);
		},
		prependListener(event, fn) {
			return on(event, fn, {prepend: true});
		},
		off(event, fn) {
			return off(event, fn);
		},
		_emitData(buf) {
			emit('data', buf);
		},
		listenerCount(event) {
			return (listeners.get(event) ?? []).length;
		},
		_peekFirst(event) {
			return (listeners.get(event) ?? [])[0];
		},
	};

	return mock;
};

const withMockedStdin = (mock, fn) => {
	const original = process.stdin;
	Object.defineProperty(process, 'stdin', {value: mock, writable: true, configurable: true});

	try {
		fn();
	} finally {
		Object.defineProperty(process, 'stdin', {value: original, writable: true, configurable: true});
	}
};

test('no-op on non-TTY', t => {
	const mock = makeMockStdin();
	mock.isTTY = false;
	withMockedStdin(mock, () => {
		stdinDiscarder.start();
		t.true(mock.isPaused());
		t.is(mock.listenerCount('data'), 0);
		stdinDiscarder.stop();
		t.true(mock.isPaused());
	});
});

test('start/stop toggles raw mode and restores pause state', t => {
	const mock = makeMockStdin();
	// Simulate already flowing before start.
	mock.resume();

	withMockedStdin(mock, () => {
		stdinDiscarder.start();
		t.false(mock.isPaused());
		t.true(mock.isRaw);

		stdinDiscarder.stop();
		t.false(mock.isPaused()); // Restored
		t.false(mock.isRaw); // Restored
	});
});

test('preserves prior raw mode true', t => {
	const mock = makeMockStdin();
	mock.setRawMode(true); // Already raw

	withMockedStdin(mock, () => {
		stdinDiscarder.start();
		t.true(mock.isRaw);
		stdinDiscarder.stop();
		t.true(mock.isRaw); // Restored to true
	});
});

test('nested start/stop is ref-counted and safe', t => {
	const mock = makeMockStdin();
	withMockedStdin(mock, () => {
		stdinDiscarder.start();
		stdinDiscarder.start();
		t.true(mock.isRaw);
		t.is(mock.listenerCount('data'), 1);

		stdinDiscarder.stop();
		t.true(mock.isRaw); // Still active

		stdinDiscarder.stop();
		t.false(mock.isRaw);
		t.is(mock.listenerCount('data'), 0);
	});
});

test('Ctrl+C: emits when there are listeners', t => {
	const mock = makeMockStdin();

	let seen = 0;
	const onSigint = () => {
		seen++;
	};

	process.on('SIGINT', onSigint);

	try {
		withMockedStdin(mock, () => {
			stdinDiscarder.start();
			mock._emitData(Buffer.from([0x03]));
			stdinDiscarder.stop();
		});
		t.is(seen, 1);
	} finally {
		process.off('SIGINT', onSigint);
	}
});

test('Ctrl+C: sends real signal when no listeners', t => {
	const mock = makeMockStdin();

	const originalKill = process.kill;
	let killCalled = 0;
	let killArgs = [];
	process.kill = (...args) => {
		killCalled++;
		killArgs = args;
		// Don't actually send the signal, just track that kill was called
		return true;
	};

	try {
		withMockedStdin(mock, () => {
			stdinDiscarder.start();
			mock._emitData(Buffer.from([0x03]));
			stdinDiscarder.stop();
		});
		t.is(killCalled, 1);
		t.is(killArgs[0], process.pid);
		t.is(killArgs[1], 'SIGINT');
	} finally {
		process.kill = originalKill;
	}
});

test('Ctrl+C: handles string-encoded chunks (if stdin has encoding)', t => {
	const mock = makeMockStdin();

	const originalKill = process.kill;
	let killCalled = 0;
	let killArgs = [];
	process.kill = (...args) => {
		killCalled++;
		killArgs = args;
		return true;
	};

	try {
		withMockedStdin(mock, () => {
			stdinDiscarder.start();
			// Simulate stdin.setEncoding('utf8') - chunk is a string
			mock._emitData('\u0003');
			stdinDiscarder.stop();
		});
		t.is(killCalled, 1);
		t.is(killArgs[0], process.pid);
		t.is(killArgs[1], 'SIGINT');
	} finally {
		process.kill = originalKill;
	}
});

test('double stop after single start is safe', t => {
	const mock = makeMockStdin();
	withMockedStdin(mock, () => {
		stdinDiscarder.start();
		stdinDiscarder.stop();

		// Second stop should be a no-op, not throw
		t.notThrows(() => {
			stdinDiscarder.stop();
		});

		// State should remain clean
		t.is(mock.listenerCount('data'), 0);
		t.false(mock.isRaw);
	});
});

test('internal listener is prepended before existing listeners', t => {
	const mock = makeMockStdin();
	const externalListener = () => {};

	// Add an external listener before start
	mock.on('data', externalListener);

	withMockedStdin(mock, () => {
		stdinDiscarder.start();

		// Verify internal handler was prepended (is first in chain)
		const firstListener = mock._peekFirst('data');
		t.not(firstListener, externalListener, 'internal handler should be prepended before external');
		t.is(mock.listenerCount('data'), 2, 'should have 2 listeners');

		stdinDiscarder.stop();
	});
});

test('external listeners added after start run after internal handler', t => {
	const mock = makeMockStdin();
	const order = [];

	withMockedStdin(mock, () => {
		stdinDiscarder.start();

		// Add listener after start - it goes to the end
		mock.on('data', () => {
			order.push('after-start');
		});

		// Add prepended listener - it goes before internal handler
		mock.prependListener('data', () => {
			order.push('prepended');
		});

		mock._emitData(Buffer.from('test'));
		stdinDiscarder.stop();
	});

	// Both should run (we can't prevent them), prepended one first
	t.is(order.length, 2);
	t.is(order[0], 'prepended');
	t.is(order[1], 'after-start');
});

test('handles empty and falsy chunks safely', t => {
	const mock = makeMockStdin();

	const originalKill = process.kill;
	let killCalled = 0;
	process.kill = () => {
		killCalled++;
		return true;
	};

	try {
		withMockedStdin(mock, () => {
			stdinDiscarder.start();

			// Empty buffer
			mock._emitData(Buffer.from([]));
			t.is(killCalled, 0, 'empty buffer should not trigger SIGINT');

			// Empty string
			mock._emitData('');
			t.is(killCalled, 0, 'empty string should not trigger SIGINT');

			// Null (edge case)
			mock._emitData(null);
			t.is(killCalled, 0, 'null should not trigger SIGINT');

			stdinDiscarder.stop();
		});
	} finally {
		process.kill = originalKill;
	}
});

test('stop without start is a safe no-op', t => {
	const mock = makeMockStdin();
	withMockedStdin(mock, () => {
		// Call stop without ever calling start
		t.notThrows(() => {
			stdinDiscarder.stop();
		});

		// State should be unchanged
		t.is(mock.listenerCount('data'), 0);
		t.false(mock.isRaw);
		t.true(mock.isPaused());
	});
});

test('Windows platform is a clean no-op', t => {
	const mock = makeMockStdin();
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

	try {
		Object.defineProperty(process, 'platform', {value: 'win32', configurable: true});

		withMockedStdin(mock, () => {
			stdinDiscarder.start();

			// No listeners should be added on Windows
			t.is(mock.listenerCount('data'), 0);
			t.false(mock.isRaw);
			t.true(mock.isPaused());

			stdinDiscarder.stop();

			// State should remain unchanged
			t.is(mock.listenerCount('data'), 0);
			t.false(mock.isRaw);
		});
	} finally {
		if (platformDescriptor) {
			Object.defineProperty(process, 'platform', platformDescriptor);
		}
	}
});

test('Windows nested start/stop maintains ref-count correctly', t => {
	const mock = makeMockStdin();
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

	try {
		Object.defineProperty(process, 'platform', {value: 'win32', configurable: true});

		withMockedStdin(mock, () => {
			// Nested starts
			stdinDiscarder.start();
			stdinDiscarder.start();

			t.is(mock.listenerCount('data'), 0, 'no listeners on Windows even with nested starts');

			// Nested stops
			stdinDiscarder.stop();
			t.is(mock.listenerCount('data'), 0, 'still no listeners after first stop');

			stdinDiscarder.stop();
			t.is(mock.listenerCount('data'), 0, 'still no listeners after final stop');

			// State never changed
			t.false(mock.isRaw);
			t.true(mock.isPaused());
		});
	} finally {
		if (platformDescriptor) {
			Object.defineProperty(process, 'platform', platformDescriptor);
		}
	}
});
