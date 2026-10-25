import tempfile,unittest
from pathlib import Path
from scripts.clean_generation import remove_checked

class PurgePathTests(unittest.TestCase):
    def test_never_removes_base_or_outside_path(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);base=root/'allowed';base.mkdir();outside=root/'preserve';outside.write_text('synthetic')
            for target in (base,outside,base/'..'/'preserve'):
                with self.assertRaisesRegex(ValueError,'purge-path-refused'):remove_checked(target,base)
            self.assertTrue(base.is_dir());self.assertEqual(outside.read_text(),'synthetic')

    def test_removes_only_resolved_child(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);child=root/'rejected';child.mkdir();(child/'fixture').write_text('synthetic')
            preserve=root/'preserve';preserve.write_text('keep');remove_checked(child,root)
            self.assertFalse(child.exists());self.assertEqual(preserve.read_text(),'keep')
