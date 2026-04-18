import { add, multiply } from '../src/math.js';

if (add(2, 3) !== 5) {
  throw new Error(`Expected add(2, 3) to equal 5, got ${add(2, 3)}`);
}

if (multiply(4, 5) !== 20) {
  throw new Error(`Expected multiply(4, 5) to equal 20, got ${multiply(4, 5)}`);
}

process.stdout.write('TEST_OK\n');
