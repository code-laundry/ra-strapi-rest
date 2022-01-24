import {
  CREATE,
  DELETE,
  DELETE_MANY,
  fetchUtils,
  GET_LIST,
  GET_MANY,
  GET_MANY_REFERENCE,
  GET_ONE,
  UPDATE,
  UPDATE_MANY,
} from 'react-admin';
import qs from 'qs';

/**
 * Maps react-admin queries to a simple REST API
 * @example
 * GET_LIST     => GET http://my.api.url/posts?sort=['title','ASC']&range=[0, 24]
 * GET_ONE      => GET http://my.api.url/posts/123
 * GET_MANY     => GET http://my.api.url/posts?filter={ids:[123,456,789]}
 * UPDATE       => PUT http://my.api.url/posts/123
 * CREATE       => POST http://my.api.url/posts
 * DELETE       => DELETE http://my.api.url/posts/123
 */
export default (apiUrl, httpClient = fetchUtils.fetchJson, uploadFields = []) => {
  /**
   * @param {String} type One of the constants appearing at the top if this file, e.g. 'UPDATE'
   * @param {String} resource Name of the resource to fetch, e.g. 'posts'
   * @param {Object} params The data request params, depending on the type
   * @returns {Object} { url, options } The HTTP request parameters
   */
  const convertDataRequestToHTTP = (type, resource, params) => {
    let url = '';
    const options = {};
    switch (type) {
      case GET_LIST:
      case GET_MANY_REFERENCE:
        url = `${apiUrl}/${resource}?${adjustQueryForStrapi(params)}`;
        break;
      case GET_ONE:
        url = `${apiUrl}/${resource}/${params.id}`;
        break;
      case UPDATE:
        url = `${apiUrl}/${resource}/${params.id}`;
        options.method = 'PUT';
        // Omit created_at/updated_at(RDS) and createdAt/updatedAt(Mongo) in request body
        const { created_at, updated_at, createdAt, updatedAt, ...data } = params.data;
        options.body = JSON.stringify({ data });
        break;
      case CREATE:
        url = `${apiUrl}/${resource}`;
        options.method = 'POST';
        options.body = JSON.stringify(params);
        break;
      case DELETE:
        url = `${apiUrl}/${resource}/${params.id}`;
        options.method = 'DELETE';
        break;
      default:
        throw new Error(`Unsupported fetch action type ${type}`);
    }
    return { url, options };
  };

  /**
   * @param {Object} params The request params
   * @param {Object} params.pagination The pagination params
   * @param {Number} params.page The page index to request
   * @param {Number} params.perPage The number of items per page
   * @param {Object} params.sort The sorting params
   * @param {String} params.field The sorting field
   * @param {String} params.order The sorting order
   * @param {Object} params.filter The filter
   * @param {String} params.target
   * @param {Object} params.id
   * @returns {String} The query string
   */
  const adjustQueryForStrapi = (params) => {
    let queryStringParams = {};

    if (params.sort) {
      let sort;
      if (params.sort.field === '') {
        sort = 'updated_at:DESC';
      } else {
        sort = `${params.sort.field}:${params.sort.order}`;
      }
      queryStringParams.sort = sort;
    }

    if (params.filter) {
      let filters = {};
      for (const filterKey in params.filter) {
        if (filterKey === 'q') {
          filters._q = params.filter[filterKey];
        } else {
          filters = {
            ...filters,
            $or: [
              {
                [filterKey]: {
                  $contains: params.filter[filterKey],
                },
              },
              {
                [filterKey]: {
                  $startsWith: params.filter[filterKey],
                },
              },
            ],
          };
        }
      }
      if (params.id && params.target && params.target.includes('_id')) {
        const target = params.target.substring(0, params.target.length - 3);
        filters[target] = params.id;
      }
      queryStringParams.filters = filters;
    }

    if (params.pagination) {
      const { page, perPage } = params.pagination;
      queryStringParams.pagination = {
        page: page,
        pageSize: perPage,
      };
    }

    return qs.stringify(queryStringParams, { encode: false });
  };

  // Determines if there are new files to upload
  // and returns file names in array if there are
  const determineUploadFieldNames = (params) => {
    if (!params.data) return [];

    // Check if the field names are mentioned in the uploadFields
    // and verify there are new files being added
    const requestUplaodFieldNames = [];
    Object.keys(params.data).forEach((field) => {
      let fieldData = params.data[field];
      if (uploadFields.includes(field)) {
        fieldData = !Array.isArray(fieldData) ? [fieldData] : fieldData;
        fieldData.filter((f) => f && f.rawFile instanceof File).length > 0 && requestUplaodFieldNames.push(field);
      }
    });

    // Return an array of field names where new files are added
    return requestUplaodFieldNames;
  };

  // Handles file uploading for CREATE and UPDATE types
  const handleFileUpload = (type, resource, params, uploadFieldNames) => {
    const { created_at, updated_at, createdAt, updatedAt, ...data } = params.data;
    const id = type === UPDATE ? `/${params.id}` : '';
    const url = `${apiUrl}/${resource}${id}`;
    const requestMethod = type === UPDATE ? 'PUT' : 'POST';
    const formData = new FormData();

    for (let fieldName of uploadFieldNames) {
      let fieldData = params.data[fieldName];
      fieldData = !Array.isArray(fieldData) ? [fieldData] : fieldData;
      const existingFileIds = [];

      for (let item of fieldData) {
        item.rawFile instanceof File
          ? formData.append(`files.${fieldName}`, item.rawFile)
          : existingFileIds.push(item.id || item._id);
      }

      data[fieldName] = [...existingFileIds];
    }
    formData.append('data', JSON.stringify(data));

    return httpClient(url, {
      method: requestMethod,
      body: formData,
    }).then((response) => ({ data: replaceRefObjectsWithIds(response.json) }));
  };

  // Replace reference objects with reference object IDs
  const replaceRefObjectsWithIds = (json) => {
    Object.keys(json).forEach((key) => {
      const fd = json[key]; // field data
      const referenceKeys = [];
      if (fd && (fd.id || fd._id) && !fd.mime) {
        json[key] = fd.id || fd._id;
      } else if (Array.isArray(fd) && fd.length > 0 && !fd[0].mime) {
        fd.map((item) => referenceKeys.push(item.id || item._id));
        json[key] = referenceKeys;
      }
    });
    return json;
  };

  function flattenEntry({ id, attributes }) {
    return { id, ...attributes };
  }

  /**
   * @param {Object} response HTTP response from fetch()
   * @param {String} type One of the constants appearing at the top if this file, e.g. 'UPDATE'
   * @param {String} resource Name of the resource to fetch, e.g. 'posts'
   * @param {Object} params The data request params, depending on the type
   * @returns {Object} Data response
   */
  const convertHTTPResponse = (response, type, resource, params) => {
    const { json } = response;

    switch (type) {
      case GET_ONE:
        return { data: replaceRefObjectsWithIds(flattenEntry(json.data)) };
      case GET_LIST:
      case GET_MANY_REFERENCE:
        return {
          data: json.data.map(flattenEntry),
          total: json.meta.pagination.total,
        };
      case CREATE:
        return { data: flattenEntry(json.data) };
      case UPDATE:
        return { data: flattenEntry(json.data) };
      case DELETE:
        return { data: { id: null } };
      default:
        return { data: flattenEntry(json.data) };
    }
  };

  /**
   * @param {string} type Request type, e.g GET_LIST
   * @param {string} resource Resource name, e.g. "posts"
   * @param {Object} payload Request parameters. Depends on the request type
   * @returns {Promise} the Promise for a data response
   */
  return (type, resource, params) => {
    // Handle file uploading
    const uploadFieldNames = determineUploadFieldNames(params);
    if (uploadFieldNames.length > 0) {
      return handleFileUpload(type, resource, params, uploadFieldNames);
    }

    // simple-rest doesn't handle filters on UPDATE route, so we fallback to calling UPDATE n times instead
    if (type === UPDATE_MANY) {
      return Promise.all(
        params.ids.map((id) => {
          // Omit created_at/updated_at(RDS) and createdAt/updatedAt(Mongo) in request body
          const { created_at, updated_at, createdAt, updatedAt, ...data } = params.data;
          return httpClient(`${apiUrl}/${resource}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
          });
        })
      ).then((responses) => ({
        data: responses.map((response) => response.json),
      }));
    }
    // simple-rest doesn't handle filters on DELETE route, so we fallback to calling DELETE n times instead
    if (type === DELETE_MANY) {
      return Promise.all(
        params.ids.map((id) =>
          httpClient(`${apiUrl}/${resource}/${id}`, {
            method: 'DELETE',
          })
        )
      ).then((responses) => ({
        data: responses.map((response) => response.json),
      }));
    }
    //strapi doesn't handle filters in GET route
    if (type === GET_MANY) {
      return Promise.all(
        params.ids.map((i) =>
          httpClient(`${apiUrl}/${resource}/${i.id || i._id || i}`, {
            method: 'GET',
          })
        )
      ).then((responses) => ({
        data: responses.map((response) => response.json),
      }));
    }

    const { url, options } = convertDataRequestToHTTP(type, resource, params);

    return httpClient(url, options).then((response) => convertHTTPResponse(response, type, resource, params));
  };
};
