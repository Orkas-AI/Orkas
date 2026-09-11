/*
 * Adapted from jStat src/special.js (erf), revision
 * e3b9787b3b1a2541927be619ae223d135cea602a. Only the normal critical-value
 * kernel is retained. erfc is evaluated directly to avoid tail cancellation;
 * bisection replaces inverse refinement for a bounded, monotone solve.
 * https://github.com/jstat/jstat/blob/e3b9787b3b1a2541927be619ae223d135cea602a/src/special.js
 *
 * Copyright (c) 2013 jStat
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
const coefficients = [
  -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
  -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
  4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
  1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
  6.529054439e-9, 5.059343495e-9, -9.91364156e-10,
  -2.27365122e-10, 9.6467911e-11, 2.394038e-12,
  -6.886027e-12, 8.94487e-13, 3.13092e-13,
  -1.12708e-13, 3.81e-16, 7.106e-15,
  -1.523e-15, -9.4e-17, 1.21e-16, -2.8e-17,
];

function erfcPositive(x) {
  const t = 2 / (2 + x);
  const ty = 4 * t - 2;
  let d = 0;
  let dd = 0;
  for (let j = coefficients.length - 1; j > 0; j--) {
    const previous = d;
    d = ty * d - dd + coefficients[j];
    dd = previous;
  }
  return t * Math.exp(-x * x + 0.5 * (coefficients[0] + ty * d) - dd);
}

// Caller validates 0 < confidenceLevel < 1. Every representable level in
// that range has a critical value below 10; no arbitrary confidence presets.
export function normalCritical(confidenceLevel) {
  let lower = 0;
  let upper = 10;
  const tail = 1 - confidenceLevel;
  for (let i = 0; i < 64; i++) {
    const middle = (lower + upper) / 2;
    if (erfcPositive(middle / Math.SQRT2) > tail) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}
