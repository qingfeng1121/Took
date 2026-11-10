import re, glob, os
base = r'D:/work/Project/Took/android/app/build/test-results/testDebugUnitTest'
for f in sorted(glob.glob(base + '/TEST-*.xml')):
    xml = open(f, encoding='utf-8').read()
    cls = re.search(r'<testsuite name="([^"]+)"', xml).group(1)
    tests = re.search(r'tests="(\d+)"', xml).group(1)
    fails = re.search(r'failures="(\d+)"', xml).group(1)
    errs = re.search(r'errors="(\d+)"', xml).group(1)
    print(f'== {cls}: tests={tests} failures={fails} errors={errs}')
    for name in re.findall(r'<testcase name="([^"]+)"', xml):
        print('  PASS', name)
