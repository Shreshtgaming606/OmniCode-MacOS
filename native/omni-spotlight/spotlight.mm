#include <node_api.h>

#import <CoreSpotlight/CoreSpotlight.h>
#import <Foundation/Foundation.h>

#include <string>

namespace {

constexpr const char *kIndexName = "OmniCodeMetadata";
constexpr const char *kDomain = "omnicode.metadata";

struct Operation {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string request;
  std::string result;
  std::string error;
};

NSString *stringValue(id value, NSUInteger maximum) {
  if (![value isKindOfClass:[NSString class]]) return nil;
  NSString *text = static_cast<NSString *>(value);
  return text.length > 0 && text.length <= maximum ? text : nil;
}

bool waitFor(dispatch_semaphore_t semaphore) {
  return dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) == 0;
}

NSString *jsonString(id value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
}

void execute(napi_env, void *context) {
  Operation *operation = static_cast<Operation *>(context);
  @autoreleasepool {
    @try {
      NSData *bytes = [NSData dataWithBytes:operation->request.data() length:operation->request.size()];
      NSDictionary *request = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
      if (![request isKindOfClass:[NSDictionary class]]) { operation->error = "Invalid Spotlight request."; return; }
      NSString *command = stringValue(request[@"command"], 32);
      if (!command) { operation->error = "Invalid Spotlight command."; return; }
      if ([command isEqualToString:@"status"]) {
        operation->result = [CSSearchableIndex isIndexingAvailable] ? "{\"available\":true}" : "{\"available\":false}";
        return;
      }
      if (![CSSearchableIndex isIndexingAvailable]) { operation->error = "Spotlight indexing is unavailable on this Mac."; return; }
      CSSearchableIndex *index = [[CSSearchableIndex alloc] initWithName:@(kIndexName)];
      dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
      __block NSError *completionError = nil;

      if ([command isEqualToString:@"index"]) {
        NSArray *source = request[@"items"];
        if (![source isKindOfClass:[NSArray class]] || source.count > 200) { operation->error = "Invalid Spotlight item batch."; return; }
        NSMutableArray<CSSearchableItem *> *items = [NSMutableArray arrayWithCapacity:source.count];
        for (id raw in source) {
          if (![raw isKindOfClass:[NSDictionary class]]) { operation->error = "Invalid Spotlight item."; return; }
          NSString *identifier = stringValue(raw[@"id"], 180);
          NSString *title = stringValue(raw[@"title"], 160);
          NSString *kind = stringValue(raw[@"kind"], 24);
          if (!identifier || !title || !([kind isEqualToString:@"workspace"] || [kind isEqualToString:@"conversation"] || [kind isEqualToString:@"action"])) {
            operation->error = "Invalid Spotlight metadata."; return;
          }
          NSString *contentType = [kind isEqualToString:@"workspace"] ? @"public.folder" : @"public.text";
          CSSearchableItemAttributeSet *attributes = [[CSSearchableItemAttributeSet alloc] initWithItemContentType:contentType];
          attributes.title = title;
          attributes.contentDescription = [kind isEqualToString:@"workspace"] ? @"OmniCode Workspace" :
            ([kind isEqualToString:@"conversation"] ? @"OmniCode Conversation" : @"OmniCode Action");
          CSSearchableItem *item = [[CSSearchableItem alloc] initWithUniqueIdentifier:identifier domainIdentifier:@(kDomain) attributeSet:attributes];
          item.expirationDate = [NSDate dateWithTimeIntervalSinceNow:180 * 24 * 60 * 60];
          [items addObject:item];
        }
        [index indexSearchableItems:items completionHandler:^(NSError *error) {
          completionError = error;
          dispatch_semaphore_signal(semaphore);
        }];
        if (!waitFor(semaphore)) { operation->error = "Spotlight indexing timed out."; return; }
        if (completionError) { operation->error = "Spotlight indexing failed."; return; }
        operation->result = "{\"ok\":true}";
        return;
      }

      if ([command isEqualToString:@"delete"]) {
        NSArray *source = request[@"ids"];
        if (![source isKindOfClass:[NSArray class]] || source.count > 200) { operation->error = "Invalid Spotlight deletion batch."; return; }
        NSMutableArray<NSString *> *ids = [NSMutableArray arrayWithCapacity:source.count];
        for (id raw in source) {
          NSString *identifier = stringValue(raw, 180);
          if (!identifier) { operation->error = "Invalid Spotlight identifier."; return; }
          [ids addObject:identifier];
        }
        [index deleteSearchableItemsWithIdentifiers:ids completionHandler:^(NSError *error) {
          completionError = error;
          dispatch_semaphore_signal(semaphore);
        }];
        if (!waitFor(semaphore)) { operation->error = "Spotlight deletion timed out."; return; }
        if (completionError) { operation->error = "Spotlight deletion failed."; return; }
        operation->result = "{\"ok\":true}";
        return;
      }

      if ([command isEqualToString:@"clear"]) {
        [index deleteSearchableItemsWithDomainIdentifiers:@[@(kDomain)] completionHandler:^(NSError *error) {
          completionError = error;
          dispatch_semaphore_signal(semaphore);
        }];
        if (!waitFor(semaphore)) { operation->error = "Spotlight clear timed out."; return; }
        if (completionError) { operation->error = "Spotlight clear failed."; return; }
        operation->result = "{\"ok\":true}";
        return;
      }

      if ([command isEqualToString:@"query"]) {
        NSString *text = stringValue(request[@"text"], 200);
        if (!text) { operation->error = "Invalid Spotlight search text."; return; }
        CSUserQueryContext *queryContext = [CSUserQueryContext userQueryContext];
        queryContext.maxResultCount = 50;
        queryContext.enableRankedResults = YES;
        if (@available(macOS 15.0, *)) {
          queryContext.disableSemanticSearch = [request[@"semantic"] boolValue] ? NO : YES;
        }
        CSUserQuery *query = [[CSUserQuery alloc] initWithUserQueryString:text userQueryContext:queryContext];
        NSMutableArray<NSDictionary *> *matches = [NSMutableArray array];
        query.foundItemsHandler = ^(NSArray<CSSearchableItem *> *found) {
          @synchronized (matches) {
            for (CSSearchableItem *item in found) {
              if (![item.domainIdentifier isEqualToString:@(kDomain)] || matches.count >= 50) continue;
              [matches addObject:@{@"id": item.uniqueIdentifier ?: @"", @"title": item.attributeSet.title ?: @""}];
            }
          }
        };
        query.completionHandler = ^(NSError *error) {
          completionError = error;
          dispatch_semaphore_signal(semaphore);
        };
        [query start];
        if (!waitFor(semaphore)) { [query cancel]; operation->error = "Spotlight query timed out."; return; }
        if (completionError) { operation->error = "Spotlight query failed."; return; }
        NSString *json = jsonString(@{@"items": matches});
        if (!json) { operation->error = "Spotlight query result failed."; return; }
        operation->result = json.UTF8String;
        return;
      }
      operation->error = "Unsupported Spotlight command.";
    } @catch (NSException *) {
      operation->error = "Spotlight encountered a native error.";
    }
  }
}

void complete(napi_env env, napi_status status, void *context) {
  Operation *operation = static_cast<Operation *>(context);
  napi_value value;
  if (status != napi_ok || !operation->error.empty()) {
    const char *message = operation->error.empty() ? "Spotlight operation failed." : operation->error.c_str();
    napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &value);
    napi_value error;
    napi_create_error(env, nullptr, value, &error);
    napi_reject_deferred(env, operation->deferred, error);
  } else {
    napi_create_string_utf8(env, operation->result.c_str(), NAPI_AUTO_LENGTH, &value);
    napi_resolve_deferred(env, operation->deferred, value);
  }
  napi_delete_async_work(env, operation->work);
  delete operation;
}

napi_value operate(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr);
  if (count != 1) { napi_throw_type_error(env, nullptr, "Spotlight expects one JSON request."); return nullptr; }
  napi_valuetype type;
  napi_typeof(env, argument, &type);
  if (type != napi_string) { napi_throw_type_error(env, nullptr, "Spotlight expects a JSON string."); return nullptr; }
  size_t length = 0;
  napi_get_value_string_utf8(env, argument, nullptr, 0, &length);
  if (length > 256 * 1024) { napi_throw_range_error(env, nullptr, "Spotlight request is too large."); return nullptr; }
  Operation *operation = new Operation();
  operation->request.resize(length + 1);
  napi_get_value_string_utf8(env, argument, operation->request.data(), length + 1, &length);
  operation->request.resize(length);
  napi_value promise;
  napi_create_promise(env, &operation->deferred, &promise);
  napi_value name;
  napi_create_string_utf8(env, "OmniCode Spotlight", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, execute, complete, operation, &operation->work);
  napi_queue_async_work(env, operation->work);
  return promise;
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "operate", NAPI_AUTO_LENGTH, operate, nullptr, &function);
  napi_set_named_property(env, exports, "operate", function);
  return exports;
}

}  // namespace

NAPI_MODULE(omnicode_spotlight, initialize)
