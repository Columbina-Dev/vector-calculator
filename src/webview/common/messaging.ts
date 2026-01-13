type VscodeApi = {
  postMessage: (message: unknown) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
};

declare const acquireVsCodeApi: () => VscodeApi;

export interface Messenger<TIn, TOut> {
  post: (message: TOut) => void;
  on: (handler: (message: TIn) => void) => void;
}

export function createMessenger<TIn, TOut>(): Messenger<TIn, TOut> {
  const vscode = acquireVsCodeApi();
  return {
    post(message: TOut) {
      vscode.postMessage(message);
    },
    on(handler: (message: TIn) => void) {
      window.addEventListener("message", (event) => {
        handler(event.data as TIn);
      });
    }
  };
}
