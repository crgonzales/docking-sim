import 'three'

declare module 'three' {
  interface Camera {
    readonly isPerspectiveCamera?: boolean
    readonly isOrthographicCamera?: boolean
  }
}
