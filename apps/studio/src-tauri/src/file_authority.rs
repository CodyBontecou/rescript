use crate::project_store::ProjectStoreError;
use std::{collections::HashMap, path::PathBuf, sync::Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityKind {
    MediaImport,
    Export,
}

#[derive(Debug)]
struct AuthorizedPath {
    path: PathBuf,
    kind: AuthorityKind,
}

#[derive(Debug, Default)]
pub struct FileAuthority {
    paths: Mutex<HashMap<String, AuthorizedPath>>,
}

impl FileAuthority {
    pub fn grant(&self, path: PathBuf, kind: AuthorityKind) -> Result<String, ProjectStoreError> {
        let mut paths = self
            .paths
            .lock()
            .map_err(|_| ProjectStoreError::FileSystem {
                message: "file authority lock is poisoned".into(),
            })?;
        if paths.len() >= 32 {
            paths.clear();
        }
        let token = format!("file-token:{}", Uuid::new_v4());
        paths.insert(token.clone(), AuthorizedPath { path, kind });
        Ok(token)
    }

    pub fn consume(
        &self,
        token: &str,
        expected_kind: AuthorityKind,
    ) -> Result<PathBuf, ProjectStoreError> {
        let mut paths = self
            .paths
            .lock()
            .map_err(|_| ProjectStoreError::FileSystem {
                message: "file authority lock is poisoned".into(),
            })?;
        let authorized = paths
            .remove(token)
            .ok_or_else(|| ProjectStoreError::InvalidInput {
                message: "file selection token is missing, expired, or already used".into(),
            })?;
        if authorized.kind != expected_kind {
            return Err(ProjectStoreError::InvalidInput {
                message: "file selection token has the wrong authority".into(),
            });
        }
        Ok(authorized.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_opaque_single_use_and_kind_scoped() {
        let authority = FileAuthority::default();
        let token = authority
            .grant(PathBuf::from("/tmp/input.wav"), AuthorityKind::MediaImport)
            .unwrap();
        assert!(token.starts_with("file-token:"));
        assert!(authority.consume(&token, AuthorityKind::Export).is_err());
        assert!(authority
            .consume(&token, AuthorityKind::MediaImport)
            .is_err());

        let token = authority
            .grant(PathBuf::from("/tmp/input.wav"), AuthorityKind::MediaImport)
            .unwrap();
        assert_eq!(
            authority
                .consume(&token, AuthorityKind::MediaImport)
                .unwrap(),
            PathBuf::from("/tmp/input.wav")
        );
        assert!(authority
            .consume(&token, AuthorityKind::MediaImport)
            .is_err());
    }
}
