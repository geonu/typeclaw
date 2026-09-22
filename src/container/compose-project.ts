// The `com.docker.compose.project` value every typeclaw container is labelled
// with. Lives in its own module so the label can be read back (to enumerate
// running agents) without importing the start pipeline that writes it.
export const COMPOSE_PROJECT = 'typeclaw'
