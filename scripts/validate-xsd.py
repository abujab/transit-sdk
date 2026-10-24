"""Validate fixtures and SDK-generated dummy requests with the unmodified official XSD.
Requires Python 3 + lxml. Never reads application environment credentials.
"""
import argparse
import hashlib
import io
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import zipfile
from lxml import etree

URL = 'https://www.mobidata-bw.de/dataset/3e6eb9a8-f119-4fdf-901a-7aab53a662dc/resource/920ff914-8813-45d4-b268-1084e9c7241d/download/trias-xsd-v1.2.zip'
SHA256 = '30b1a8e43a315bd833d8f558bd8e014a9eae4c01283428794dcca65eeb47ee77'
ROOT = Path(__file__).resolve().parents[1]
args = argparse.ArgumentParser()
args.add_argument('--schema-archive', type=Path, help='Use an already downloaded official ZIP (checksum still required)')
args = args.parse_args()
archive = args.schema_archive.read_bytes() if args.schema_archive else urllib.request.urlopen(URL, timeout=60).read()
if hashlib.sha256(archive).hexdigest() != SHA256:
    raise SystemExit('Official XSD archive checksum changed; review the upstream change before updating the pin')
parser = etree.XMLParser(resolve_entities=False, no_network=True)
with tempfile.TemporaryDirectory(prefix='transit-xsd-') as tmp:
    directory = Path(tmp)
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        for entry in bundle.infolist():
            if not (directory / entry.filename).resolve().is_relative_to(directory.resolve()):
                raise SystemExit('Unsafe archive path')
        bundle.extractall(directory)
    schema = etree.XMLSchema(etree.parse(str(directory / 'Trias.xsd'), parser))
    generated = directory / 'generated'
    generated.mkdir()
    subprocess.run(['node', 'scripts/schema-requests.mjs', str(generated)], cwd=ROOT, check=True)
    fixtures = ROOT / 'test' / 'fixtures'
    paths = sorted(fixtures.glob('*.xml')) + sorted(generated.glob('*.xml'))
    checked = 0
    for path in paths:
        document = etree.parse(str(path), parser)
        valid = schema.validate(document)
        if path.name == 'mentz-trip-realtime.xml':
            # The MENTZ PDF documents flat service fields; VDV requires ServiceSection.
            if valid or not any('ServiceSection' in error.message for error in schema.error_log):
                raise SystemExit('Expected MENTZ/VDV ServiceSection discrepancy changed')
            continue
        if not valid:
            # Schema diagnostics can include values. Never dump XML or diagnostics.
            raise SystemExit(f'Schema validation failed: {path.name}')
        checked += 1
    ns = {'t': 'http://www.vdv.de/trias'}
    # Negative controls show the unmodified XSD detects the original defects.
    for original, replacement in [('LocationInformationResponse', 'LocationInformationDelivery'), ('TripResponse', 'TripDelivery')]:
        source = fixtures / ('location-single.xml' if original.startswith('Location') else 'trip-scheduled.xml')
        document = etree.parse(str(source), parser)
        document.xpath('//' + 't:' + original, namespaces=ns)[0].tag = '{' + ns['t'] + '}' + replacement
        if schema.validate(document):
            raise SystemExit('Schema accepted an invalid delivery name')
    for defect in ['old-name', 'wrong-location', 'zero']:
        document = etree.parse(str(generated / 'trip-departure-2-generated.xml'), parser)
        element = document.xpath('//t:InterchangeLimit', namespaces=ns)[0]
        if defect == 'old-name':
            element.tag = '{' + ns['t'] + '}NumberOfInterchanges'
        elif defect == 'wrong-location':
            element.getparent().getparent().append(element)
        else:
            element.text = '0'
        if schema.validate(document):
            raise SystemExit('Schema accepted an invalid interchange parameter')
    print(f'Validated {checked} XML documents against official TRIAS 1.2 XSD; 5 negative controls rejected; MENTZ profile discrepancy confirmed')
