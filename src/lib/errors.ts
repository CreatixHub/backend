export class HttpError extends Error{
  constructor(
    public status: number, 
    message: string,
    public errors? : {field: string; message: string}[],
  ){
    super(message);
  }
}
