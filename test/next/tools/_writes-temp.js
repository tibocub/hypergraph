// A fixture for test-runner.js, not run by the runner (it starts with _): writes a file
// in its temp folder, which must be its own one inside EXPECT_ROOT.

const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')

test('writes in its own temp folder', (t) => {
  t.is(path.dirname(os.tmpdir()), path.resolve(process.env.EXPECT_ROOT), 'a folder of its own in the temp folder')
  t.is(process.env.HG_TEST_TMP, os.tmpdir(), 'HG_TEST_TMP names it too')
  fs.writeFileSync(path.join(os.tmpdir(), 'left-behind.txt'), 'x')
})
